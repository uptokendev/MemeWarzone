/**
 * POST /api/coin-page/image?chainId=&token=&slot=banner|post|section:<key> (multipart, field `file`).
 * UI redesign phase 1b. Owner-signed (`coin_page_image`, lines `Token:` and `Slot:`), same image
 * checks as /api/upload (5 MB, png/jpeg/webp by magic bytes). Stores the file and returns its URL;
 * it writes no row — the page saves the URL through /api/coin-page/profile or /posts.
 */
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";
import { pool } from "../server/db.js";
import { inspectImageFile, PROJECT_IMPORT_IMAGE_LIMITS } from "./lib/imageFileValidation.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { coinIdent, coinPageOwner } from "./lib/coinPageOwner.js";
import { coinImagePath, parseImageSlot } from "./lib/coinPageCanon.js";

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
  const token = coinIdent(chainId, q.token);
  const slot = parseImageSlot(q.slot);
  if (!chainId || !token) return bad(res, 400, "chainId and token are required", "COIN_IDENTITY_REQUIRED");
  if (!slot) return bad(res, 400, "Unknown image slot", "COIN_IMAGE_SLOT");

  const limits = PROJECT_IMPORT_IMAGE_LIMITS;
  const form = formidable({ multiples: false, maxFileSize: limits.maxBytes, maxTotalFileSize: limits.maxBytes });
  try {
    const [fields, files] = await form.parse(req);
    const owner = await coinPageOwner(pool, chainId, token);
    if (!owner) return bad(res, 403, "Only the verified owner of this coin can upload its images.", "COIN_NOT_OWNER");

    // Same transport as /api/upload: auth in form fields, falling back to the query string.
    const field = (key) => first(fields, key) || String(q[key] || "").trim();
    const verified = await requireWalletActionAuth({
      res,
      pool,
      auth: {
        action: field("action") || "coin_page_image",
        walletAddress: field("walletAddress") || owner.wallet,
        chainId,
        nonce: field("nonce"),
        message: field("message").replace(/\r\n/g, "\n"),
        signature: field("signature"),
        walletType: field("walletType"),
      },
      expectedWallet: owner.wallet,
      chainId,
      action: "coin_page_image",
      routeLabel: "coin-page/image",
      extraLines: [`Token: ${owner.token}`, `Slot: ${slot}`],
      strict: true,
    });
    if (!verified) return;

    const raw = files.file;
    const f = Array.isArray(raw) ? raw[0] : raw;
    if (!f) return bad(res, 400, "Missing file (field name: file)", "COIN_IMAGE_MISSING");
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
      return bad(res, 400, String(error?.message || "Image is invalid"), "COIN_IMAGE_INVALID");
    }

    let supabase;
    try {
      supabase = getStorageClient();
    } catch {
      return bad(res, 503, "Uploads are not configured", "COIN_IMAGE_STORAGE");
    }
    const bucket = process.env.SUPABASE_BUCKET || "MEMEBATTLES";
    const uuid = crypto.randomUUID();
    const name = coinImagePath({ chainId, token: owner.token, slot, uuid, ext: info.ext });
    const up = await supabase.storage.from(bucket).upload(name, buf, { contentType: info.mime, upsert: false, cacheControl: "3600" });
    if (up.error) {
      console.error("[api/coin-page/image] supabase", up.error);
      return bad(res, 500, "Upload failed", "COIN_IMAGE_UPLOAD");
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(name);
    if (!data?.publicUrl) return bad(res, 500, "Failed to produce public URL", "COIN_IMAGE_UPLOAD");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, url: data.publicUrl, slot }));
  } catch (error) {
    const tooBig = /maxFileSize|maxTotalFileSize/i.test(String(error?.message || ""));
    if (tooBig) return bad(res, 413, "Image is too large. Maximum size is 5 MB.", "COIN_IMAGE_TOO_LARGE");
    console.error("[api/coin-page/image]", error);
    return bad(res, 500, "Upload failed", "COIN_IMAGE_UPLOAD");
  }
}
