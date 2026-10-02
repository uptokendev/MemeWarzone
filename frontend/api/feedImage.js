/**
 * POST /api/feed/image?chainId=&address= (multipart, field `file`). UI redesign phase 2.
 * Any wallet may attach an image to its own post: signed `feed_post_image` by that wallet, same
 * image checks as /api/upload (5 MB, png/jpeg/webp by magic bytes). Stores the file under
 * social-posts/<wallet>/ and returns its URL; it writes no row (the post create binds the URL).
 */
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";
import { pool } from "../server/db.js";
import { inspectImageFile, PROJECT_IMPORT_IMAGE_LIMITS } from "./lib/imageFileValidation.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { canonPostWallet } from "./lib/postsCanon.js";
import { feedImagePath } from "./lib/feedPostMedia.js";

let storageClient = null;
function getStorageClient() {
  if (storageClient) return storageClient;
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new Error("Supabase upload storage env is missing");
  storageClient = createClient(url, key);
  return storageClient;
}

function bad(res, status, error, code) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error, code }));
}

function first(fields, key) {
  const v = fields?.[key];
  return String(Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
}

export default async function handler(req, res) {
  if (String(req.method || "").toUpperCase() !== "POST") return bad(res, 405, "Method not allowed");
  const q = req.query || Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  const chainId = Number(q.chainId || 0);
  const address = canonPostWallet(chainId, q.address);
  if (!chainId || !address) return bad(res, 400, "chainId and address are required", "FEED_IMAGE_IDENTITY");

  const limits = PROJECT_IMPORT_IMAGE_LIMITS;
  const form = formidable({ multiples: false, maxFileSize: limits.maxBytes, maxTotalFileSize: limits.maxBytes });
  try {
    const [fields, files] = await form.parse(req);
    const field = (key) => first(fields, key) || String(q[key] || "").trim();
    const verified = await requireWalletActionAuth({
      res,
      pool,
      auth: {
        action: field("action") || "feed_post_image",
        walletAddress: field("walletAddress") || address,
        chainId,
        nonce: field("nonce"),
        message: field("message").replace(/\r\n/g, "\n"),
        signature: field("signature"),
        walletType: field("walletType"),
      },
      expectedWallet: address,
      chainId,
      action: "feed_post_image",
      routeLabel: "feed/image",
      strict: true,
    });
    if (!verified) return;

    const raw = files.file;
    const f = Array.isArray(raw) ? raw[0] : raw;
    if (!f) return bad(res, 400, "Missing file (field name: file)", "FEED_IMAGE_MISSING");
    const filepath = f.filepath || f.path;
    const buf = fs.readFileSync(filepath);
    try {
      fs.unlinkSync(filepath);
    } catch {}

    let info;
    try {
      info = inspectImageFile(buf, {
        declaredMime: String(f.mimetype || ""),
        maxBytes: limits.maxBytes,
        maxDimension: limits.maxDimension,
        maxPixels: limits.maxPixels,
      });
    } catch (error) {
      return bad(res, 400, String(error?.message || "Image is invalid"), "FEED_IMAGE_INVALID");
    }

    let supabase;
    try {
      supabase = getStorageClient();
    } catch {
      return bad(res, 503, "Uploads are not configured", "FEED_IMAGE_STORAGE");
    }
    const bucket = process.env.SUPABASE_BUCKET || "MEMEBATTLES";
    const name = feedImagePath({ wallet: address, uuid: crypto.randomUUID(), ext: info.ext });
    const up = await supabase.storage.from(bucket).upload(name, buf, { contentType: info.mime, upsert: false, cacheControl: "3600" });
    if (up.error) {
      console.error("[api/feed/image] supabase", up.error);
      return bad(res, 500, "Upload failed", "FEED_IMAGE_UPLOAD");
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(name);
    if (!data?.publicUrl) return bad(res, 500, "Failed to produce public URL", "FEED_IMAGE_UPLOAD");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, url: data.publicUrl }));
  } catch (error) {
    const tooBig = /maxFileSize|maxTotalFileSize/i.test(String(error?.message || ""));
    if (tooBig) return bad(res, 413, "Image is too large. Maximum size is 5 MB.", "FEED_IMAGE_TOO_LARGE");
    console.error("[api/feed/image]", error);
    return bad(res, 500, "Upload failed", "FEED_IMAGE_UPLOAD");
  }
}
