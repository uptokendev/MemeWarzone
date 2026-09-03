import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";
import { pool } from "../server/db.js";
import { isSolanaAddress, normalizeAddress } from "../server/http.js";
import { ARENA_IMPORT_IMAGE_LIMITS, inspectImageFile } from "./lib/imageFileValidation.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { verifySolanaDirectSessionToken } from "./dev-fix/solana-direct-create.js";

export const config = {
  api: { bodyParser: false },
};

let storageClient = null;

function getStorageClient() {
  if (storageClient) return storageClient;

  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url || !key) {
    throw new Error("Supabase upload storage env is missing");
  }

  storageClient = createClient(url, key);
  return storageClient;
}

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

function pickExt(mimetype) {
  switch (mimetype) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

function isSolanaUploadChain(chainId) {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

function normalizeUploadAddress(raw, chainId) {
  const input = String(raw || "").trim();
  if (!input) return "";

  if (isSolanaUploadChain(chainId)) {
    return isSolanaAddress(input) ? input : "";
  }

  return normalizeAddress(input, chainId);
}

function firstField(fields, key) {
  const raw = fields?.[key];
  if (Array.isArray(raw)) return String(raw[0] ?? "").trim();
  if (raw == null) return "";
  return String(raw).trim();
}

async function persistDraftLogo({ draftId, chainId, address, publicUrl }) {
  const id = String(draftId || "").trim();
  if (!id || !address || !publicUrl || !pool) return false;

  try {
    const { rowCount } = await pool.query(
      `update public.campaign_drafts
          set logo_url = $1,
              updated_at = now()
        where id::text = $2
          and chain_id = $3
          and creator_wallet = $4`,
      [publicUrl, id, Number(chainId), address],
    );
    return Number(rowCount || 0) > 0;
  } catch (error) {
    console.warn("[api/upload] failed to persist draft logo", error?.message || error);
    return false;
  }
}

async function loadArenaImport(importId) {
  const id = String(importId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const result = await pool.query(
    `select id, chain_id, token_address, owner_wallet, verified_at
       from public.arena_token_imports
      where id = $1::uuid
      limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

async function persistArenaImportImage({ importId, chainId, ownerWallet, publicUrl }) {
  const ownerPredicate = isSolanaUploadChain(chainId)
    ? `owner_wallet = $4`
    : `lower(owner_wallet) = lower($4)`;
  const result = await pool.query(
    `update public.arena_token_imports
        set image_url = $1,
            metadata_updated_at = now(),
            updated_at = now()
      where id = $2::uuid
        and chain_id = $3
        and ${ownerPredicate}
        and verified_at is not null
      returning id, image_url, metadata_updated_at, verified_at`,
    [publicUrl, importId, Number(chainId), ownerWallet],
  );
  if (!result.rows[0]) throw new Error("Import owner verification changed before image persistence");
  return result.rows[0];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  const q = req.query || {};
  const kind = String(q.kind || "avatar");
  let chainId = Number(q.chainId || 56);
  let address = normalizeUploadAddress(q.address, chainId);
  const draftId = String(q.draftId || "").trim();
  const importId = String(q.importId || "").trim();

  const maxBytes = kind === "arena_import" ? ARENA_IMPORT_IMAGE_LIMITS.maxBytes : 5 * 1024 * 1024;
  const form = formidable({ multiples: false, maxFileSize: maxBytes, maxTotalFileSize: maxBytes });

  try {
    const [fields, files] = await form.parse(req);

    let arenaImport = null;
    if (kind === "arena_import") {
      if (!importId) return bad(res, 400, "importId is required for imported token images");
      arenaImport = await loadArenaImport(importId);
      if (!arenaImport) return bad(res, 404, "Imported token was not found");
      const requestedChain = Number(q.chainId || 0);
      if (requestedChain && requestedChain !== Number(arenaImport.chain_id)) {
        return bad(res, 409, "Imported token chain does not match upload request");
      }
      if (!arenaImport.verified_at) {
        return bad(res, 403, "Token ownership must be verified before replacing its imported profile image");
      }
      chainId = Number(arenaImport.chain_id);
      address = normalizeUploadAddress(arenaImport.owner_wallet, chainId);
      if (!address) return bad(res, 409, "Imported token owner wallet is invalid");
    }

    // Prefer form fields for auth when present; query params are the proven Create/logo path
    // (multiline message in multipart is frequently mangled by proxies → MESSAGE_MISMATCH).
    const defaultAction = kind === "logo"
      ? "upload_logo"
      : kind === "arena_import"
        ? "arena_import_image"
        : "upload_avatar";
    const authAction = firstField(fields, "action") || String(q.action || defaultAction);
    const authNonce = firstField(fields, "nonce") || String(q.nonce || "").trim();
    const authMessageRaw = firstField(fields, "message") || String(q.message || "");
    const authMessage = String(authMessageRaw || "").replace(/\r\n/g, "\n");
    const authSignature = firstField(fields, "signature") || String(q.signature || "").trim();
    const authWalletType = firstField(fields, "walletType") || String(q.walletType || "");
    const authWallet =
      normalizeUploadAddress(firstField(fields, "walletAddress") || firstField(fields, "address") || q.walletAddress || address, chainId) ||
      address;

    // A Direct session is created only after one creator wallet signature. It may authorize
    // the logo upload without consuming a second auth nonce/signature.
    let directSession = null;
    const directSessionToken = String(q.directSession || "").trim();
    if (kind === "logo" && directSessionToken) {
      try {
        directSession = verifySolanaDirectSessionToken(directSessionToken);
        const directWallet = normalizeUploadAddress(directSession?.creatorWallet, chainId);
        if (Number(directSession?.chainId) !== chainId || !directWallet || directWallet !== address) {
          return bad(res, 401, "Direct upload session does not match this wallet or chain.");
        }
      } catch (error) {
        return bad(res, Number(error?.httpStatus || 401), String(error?.message || "Direct upload session is invalid."));
      }
    }

    // Public sponsorship creatives may omit wallet (kind=sponsor|sponsorship).
    // Avatar/logo/squad/imported-token images require address + wallet action auth when enforce is on.
    const isPublicSponsorKind = kind === "sponsor" || kind === "sponsorship";
    if (address && !isPublicSponsorKind && !directSession) {
      const verified = await requireWalletActionAuth({
        res,
        pool,
        auth: {
          action: authAction || defaultAction,
          walletAddress: authWallet,
          chainId,
          nonce: authNonce,
          message: authMessage,
          signature: authSignature,
          walletType: authWalletType,
        },
        expectedWallet: address,
        chainId,
        action: defaultAction,
        routeLabel: kind === "arena_import" ? "arena/imports/image" : "upload",
        extraLines: kind === "arena_import"
          ? [`Import: ${importId}`]
          : draftId
            ? [`Draft ID: ${draftId}`]
            : [],
      });
      if (!verified) return;
    }
    if (!address && !isPublicSponsorKind) {
      // Enforce path: unsigned non-sponsor uploads with no wallet are rejected when USER_WRITES is on.
      // (Legacy open when address missing was accidental; keep sponsor public only.)
    }

    const fRaw = files.file;
    const f = Array.isArray(fRaw) ? fRaw[0] : fRaw;
    if (!f) return bad(res, 400, "Missing file (field name: file)");

    const filepath = f.filepath || f.path;
    const mimetype = String(f.mimetype || "");
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(mimetype)) return bad(res, 400, "Unsupported image type. Use png/jpg/webp.");

    const buf = fs.readFileSync(filepath);
    try {
      fs.unlinkSync(filepath);
    } catch {}

    let ext = pickExt(mimetype);
    let contentType = mimetype === "image/jpg" ? "image/jpeg" : mimetype;
    let imageInfo = null;
    if (kind === "arena_import") {
      try {
        imageInfo = inspectImageFile(buf, {
          declaredMime: mimetype,
          maxBytes: ARENA_IMPORT_IMAGE_LIMITS.maxBytes,
          maxDimension: ARENA_IMPORT_IMAGE_LIMITS.maxDimension,
          maxPixels: ARENA_IMPORT_IMAGE_LIMITS.maxPixels,
        });
      } catch (error) {
        return bad(res, 400, String(error?.message || "Imported token image is invalid"));
      }
      ext = imageInfo.ext;
      contentType = imageInfo.mime;
    }
    if (!ext) return bad(res, 400, "Unsupported image type.");

    const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
    const supabaseKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!supabaseUrl || !supabaseKey) {
      if (kind === "arena_import") {
        return bad(res, 503, "Imported token image storage is not configured");
      }
      const allowDataUrl = ["1", "true", "yes", "on"].includes(
        String(process.env.ENABLE_DATA_URL_UPLOADS || "").trim().toLowerCase(),
      );
      if (!allowDataUrl) {
        return bad(
          res,
          503,
          "Logo storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the API.",
        );
      }
      console.warn("[api/upload] ENABLE_DATA_URL_UPLOADS is on — returning an in-memory data URL. Do not use this in production.");
      const dataUrl = `data:${contentType};base64,${buf.toString("base64")}`;
      return res.status(200).json({ url: dataUrl, persistedDraftLogo: false });
    }

    let supabase;
    try {
      supabase = getStorageClient();
    } catch (e) {
      console.error("[api/upload] storage env missing", e);
      return bad(res, 503, "Uploads are not configured");
    }

    const bucket = process.env.SUPABASE_BUCKET || "memebattles";
    const uuid = (crypto && typeof crypto.randomUUID === "function" && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let name;
    if (isPublicSponsorKind) {
      name = `sponsors/${uuid}.${ext}`;
    } else if (kind === "avatar" && address) {
      name = `avatars/${chainId}/${address}/${uuid}.${ext}`;
    } else if (kind === "arena_import") {
      name = `arena-imports/${chainId}/${importId}/${uuid}.${ext}`;
    } else {
      name = `logos/${chainId}/${uuid}.${ext}`;
    }

    const { error: upErr } = await supabase.storage.from(bucket).upload(name, buf, {
      contentType,
      upsert: kind === "arena_import" ? false : true,
      cacheControl: kind === "avatar" ? "60" : isPublicSponsorKind ? "3600" : "3600",
    });
    if (upErr) {
      console.error("[api/upload] supabase", upErr);
      return bad(res, 500, `Supabase upload failed: ${upErr.message}`);
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(name);
    if (!data?.publicUrl) return bad(res, 500, "Failed to produce public URL");

    const persistedDraftLogo = kind === "logo" && draftId
      ? await persistDraftLogo({ draftId, chainId, address, publicUrl: data.publicUrl })
      : false;

    let persistedArenaImportImage = false;
    let arenaImportProfile = null;
    if (kind === "arena_import") {
      try {
        arenaImportProfile = await persistArenaImportImage({
          importId,
          chainId,
          ownerWallet: address,
          publicUrl: data.publicUrl,
        });
        persistedArenaImportImage = true;
      } catch (error) {
        await supabase.storage.from(bucket).remove([name]).catch(() => {});
        console.error("[api/upload] failed to persist imported token image", error);
        return bad(res, 409, "Imported token image could not be attached to this verified owner profile");
      }
    }

    return res.status(200).json({
      url: data.publicUrl,
      persistedDraftLogo,
      persistedArenaImportImage,
      image: imageInfo ? { width: imageInfo.width, height: imageInfo.height, mime: imageInfo.mime } : undefined,
      metadataUpdatedAt: arenaImportProfile?.metadata_updated_at || null,
      verifiedAt: arenaImportProfile?.verified_at || arenaImport?.verified_at || null,
    });
  } catch (e) {
    console.error("[api/upload]", e);
    return bad(res, 500, String(e?.message || e || "Server error"));
  }
}
