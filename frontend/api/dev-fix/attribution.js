import crypto from "crypto";
import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, json, readJson } from "../../server/http.js";
import { internalRecruiterLabel, isOwnerWallet } from "../../shared/ownerWallets.mjs";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  badMethod(res);
  return false;
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (isSolanaAddress(raw)) return raw;
  const lower = raw.toLowerCase();
  return isAddress(lower) ? lower : "";
}

function isSolanaWallet(value) {
  return isSolanaAddress(String(value || "").trim());
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function normalizeText(value, max = 280) {
  return String(value || "").trim().slice(0, max);
}

function normalizeMemberRole(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "creator" || raw === "trader" || raw === "both" ? raw : "";
}

function mergeMemberRole(existingValue, incomingValue) {
  const existing = normalizeMemberRole(existingValue);
  const incoming = normalizeMemberRole(incomingValue);
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing === "both" || incoming === "both" || existing !== incoming) return "both";
  return existing;
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function envFlag(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function preliveRecruitersAreOg() {
  return envFlag("PRELIVE_RECRUITERS_ARE_OG", true);
}

function makeNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function publicState({ walletAddress, state = null, recruiter = null, membership = null }) {
  const isRecruiterWallet = Boolean(recruiter);
  const rawSquadState = String(!isRecruiterWallet && membership ? "in_squad" : state?.squad_state || "").trim().toLowerCase();
  const normalizedSquadState = ["in_squad", "linked_squad", "active_squad", "squad_member", "member"].includes(rawSquadState)
    ? "in_squad"
    : "solo";

  return {
    walletAddress,
    hasActivity: Boolean(state?.has_activity),
    recruiterLinkState: state?.recruiter_link_state || (recruiter ? "self_recruiter_wallet" : "unlinked"),
    recruiterCode: state?.recruiter_code || membership?.recruiter_code || recruiter?.code || null,
    recruiterDisplayName: state?.recruiter_display_name || membership?.recruiter_display_name || recruiter?.display_name || null,
    recruiterIsOg: Boolean(state?.recruiter_is_og ?? membership?.recruiter_is_og ?? recruiter?.is_og),
    squadState: isRecruiterWallet ? "solo" : normalizedSquadState,
  };
}

function recruiterSummaryShape(recruiter, extra = {}) {
  return {
    recruiterId: Number(recruiter.id),
    walletAddress: recruiter.metadata?.signup?.solanaWalletAddress || recruiter.wallet_address,
    code: recruiter.code,
    displayName: recruiter.display_name,
    isOg: Boolean(recruiter.is_og),
    status: recruiter.status,
    closedAt: recruiter.closed_at,
    linkedWalletCount: Number(extra.linkedWalletCount || 0),
    linkedCreatorsCount: Number(extra.linkedCreatorsCount || 0),
    linkedTradersCount: Number(extra.linkedTradersCount || 0),
    activeSquadMemberCount: Number(extra.activeSquadMemberCount || 0),
    referredEventCount: Number(extra.referredEventCount || 0),
    referredVolumeRaw: String(extra.referredVolumeRaw || "0"),
    recruiterRouteAmountRaw: String(extra.recruiterRouteAmountRaw || "0"),
    lastReferredEventAt: extra.lastReferredEventAt || null,
    latestLinkedActivityAt: extra.latestLinkedActivityAt || null,
    pendingEarningsRaw: String(extra.pendingEarningsRaw || "0"),
    claimableEarningsRaw: String(extra.claimableEarningsRaw || "0"),
    totalEarnedRaw: String(extra.totalEarnedRaw || "0"),
    claimedLifetimeRaw: String(extra.claimedLifetimeRaw || "0"),
    lastClaimedAt: extra.lastClaimedAt || null,
    weightedScore: Number(extra.weightedScore || 0),
    createdAt: recruiter.created_at || null,
    updatedAt: recruiter.updated_at || null,
    materializedAt: new Date().toISOString(),
  };
}

function buildRecruiterSignupMessage({ chainId, walletAddress, nonce, displayName, desiredCode, email, telegram, discord, xHandle, pitch }) {
  return [
    "MemeWarzone Recruiter Signup",
    "Action: RECRUITER_SIGNUP",
    `Wallet: ${walletAddress}`,
    `ChainId: ${chainId ?? ""}`,
    `Nonce: ${String(nonce || "").trim()}`,
    "",
    `DisplayName: ${normalizeText(displayName, 40)}`,
    `DesiredCode: ${normalizeCode(desiredCode)}`,
    `Email: ${normalizeText(email, 120)}`,
    `Telegram: ${normalizeText(telegram, 80)}`,
    `Discord: ${normalizeText(discord, 80)}`,
    `X: ${normalizeText(xHandle, 80)}`,
    "",
    `Pitch: ${normalizeText(pitch, 1000)}`,
  ].join("\n");
}

function base58Decode(value) {
  const input = String(value || "").trim();
  if (!input) return Buffer.alloc(0);
  let bytes = [0];
  for (const char of input) {
    const carryValue = BASE58_MAP.get(char);
    if (carryValue == null) throw new Error("Invalid base58 value");
    let carry = carryValue;
    for (let i = 0; i < bytes.length; i += 1) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return Buffer.from(bytes.reverse());
}

function verifySolanaSignature(message, signatureBase64, walletAddress) {
  try {
    const signature = Buffer.from(String(signatureBase64 || ""), "base64");
    const publicKey = base58Decode(walletAddress);
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    const keyObject = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, signature);
  } catch (error) {
    console.error("[api/recruiter signup solana verify]", error);
    return false;
  }
}

function verifySignupSignature({ walletAddress, message, signature }) {
  if (isSolanaWallet(walletAddress)) return verifySolanaSignature(message, signature, walletAddress);
  const recovered = ethers.verifyMessage(message, signature).toLowerCase();
  return recovered === walletAddress.toLowerCase();
}

function walletMatchSql(column = "wallet_address") {
  return `(case when $2::boolean then ${column} = $1 or metadata #>> '{signup,solanaWalletAddress}' = $1 else lower(${column}) = lower($1) end)`;
}

async function findRecruiterByCode(code) {
  const { rows } = await pool.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at, metadata, created_at, updated_at
       from public.recruiters
      where lower(code) = lower($1)
      limit 1`,
    [code],
  );
  return rows[0] || null;
}

async function findRecruiterByWallet(walletAddress) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at, metadata, created_at, updated_at
       from public.recruiters
      where ${walletMatchSql("wallet_address")}
      limit 1`,
    [walletAddress, solana],
  );
  return rows[0] || null;
}

async function findWalletAttributionState(walletAddress) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select *
       from public.wallet_attribution_states
      where case when $2::boolean then wallet_address = $1 else lower(wallet_address) = lower($1) end
      limit 1`,
    [walletAddress, solana],
  );
  return rows[0] || null;
}

async function findActiveSquadMembership(walletAddress) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select s.wallet_address,
            s.recruiter_id,
            r.code as recruiter_code,
            r.display_name as recruiter_display_name,
            r.is_og as recruiter_is_og,
            s.member_role,
            s.link_source,
            s.joined_at,
            s.is_active
       from public.wallet_squad_memberships s
       join public.recruiters r on r.id = s.recruiter_id
      where case when $2::boolean then s.wallet_address = $1 else lower(s.wallet_address) = lower($1) end
        and s.is_active = true
        and lower(s.wallet_address) <> lower(r.wallet_address)
      limit 1`,
    [walletAddress, solana],
  );
  return rows[0] || null;
}

async function findWalletClusterId(walletAddress) {
  const wallet = normalizeAddress(walletAddress);
  if (!wallet) return null;
  try {
    const { rows } = await pool.query(
      `select cluster_id
         from public.wallet_risk_profiles
        where lower(wallet_address) = lower($1)
        limit 1`,
      [wallet],
    );
    return rows[0]?.cluster_id ? String(rows[0].cluster_id) : null;
  } catch (error) {
    if (schemaMissing(error)) return null;
    console.error("[api/attribution cluster lookup]", error);
    return null;
  }
}

async function isSameWalletCluster(leftWallet, rightWallet) {
  const [leftCluster, rightCluster] = await Promise.all([
    findWalletClusterId(leftWallet),
    findWalletClusterId(rightWallet),
  ]);
  return Boolean(leftCluster && rightCluster && leftCluster === rightCluster);
}

async function findLatestWindow({ sessionToken, clientFingerprint, walletAddress }) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select w.*, r.code, r.display_name, r.is_og, r.status
       from public.wallet_referral_attribution_windows w
       join public.recruiters r on r.id = w.recruiter_id
      where w.consumed_at is null
        and w.expires_at > now()
        and (
          ($1::text is not null and w.session_token = $1::text)
          or ($2::text is not null and w.client_fingerprint = $2::text)
          or ($3::text is not null and case when $4::boolean then w.wallet_address = $3::text else lower(w.wallet_address) = lower($3::text) end)
        )
      order by w.captured_at desc, w.id desc
      limit 1`,
    [sessionToken || null, clientFingerprint || null, walletAddress || null, solana],
  );
  return rows[0] || null;
}

async function getRecruiterStats(recruiterId, recruiterWalletAddress = "") {
  // Count creators/traders from both squad memberships AND recruiter links. Explicit
  // role wins; legacy generic members are inferred from creator activity. A `both`
  // wallet counts once as an active member and in both role totals.
  const [{ rows: linkRows }, { rows: roleRows }] = await Promise.all([
    pool.query(
      `select count(*)::int as linked_wallet_count,
              max(linked_at) as latest_linked_activity_at
         from public.wallet_recruiter_links l
         left join public.wallet_risk_profiles lwr on lower(lwr.wallet_address) = lower(l.wallet_address)
         left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower($2)
        where l.recruiter_id = $1
          and l.is_active = true
          and lower(l.wallet_address) <> lower($2)
          and not (lwr.cluster_id is not null and rwr.cluster_id is not null and lwr.cluster_id = rwr.cluster_id)`,
      [recruiterId, recruiterWalletAddress || ""],
    ),
    pool.query(
      `with members as (
         select lower(s.wallet_address) as wallet,
                lower(coalesce(s.member_role, 'member')) as member_role
           from public.wallet_squad_memberships s
           left join public.wallet_risk_profiles swr on lower(swr.wallet_address) = lower(s.wallet_address)
           left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower($2)
          where s.recruiter_id = $1
            and s.is_active = true
            and lower(s.wallet_address) <> lower($2)
            and not (swr.cluster_id is not null and rwr.cluster_id is not null and swr.cluster_id = rwr.cluster_id)
         union
         select lower(l.wallet_address) as wallet,
                'member'::text as member_role
           from public.wallet_recruiter_links l
           left join public.wallet_risk_profiles lwr on lower(lwr.wallet_address) = lower(l.wallet_address)
           left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower($2)
          where l.recruiter_id = $1
            and l.is_active = true
            and lower(l.wallet_address) <> lower($2)
            and not (lwr.cluster_id is not null and rwr.cluster_id is not null and lwr.cluster_id = rwr.cluster_id)
       ),
       classified as (
         select
           m.wallet,
           case
             when bool_or(m.member_role in ('creator','trader','both'))
               then bool_or(m.member_role in ('creator','both'))
             else exists (
               select 1 from public.campaigns c
                where lower(c.creator_address) = m.wallet
             )
           end as is_creator,
           case
             when bool_or(m.member_role in ('creator','trader','both'))
               then bool_or(m.member_role in ('trader','both'))
             else not exists (
               select 1 from public.campaigns c
                where lower(c.creator_address) = m.wallet
             )
           end as is_trader
         from members m
         group by m.wallet
       )
       select
         count(*)::int as active_squad_member_count,
         count(*) filter (where is_creator)::int as linked_creators_count,
         count(*) filter (where is_trader)::int as linked_traders_count
         from classified`,
      [recruiterId, recruiterWalletAddress || ""],
    ),
  ]);

  return {
    linkedWalletCount: linkRows[0]?.linked_wallet_count || 0,
    activeSquadMemberCount: roleRows[0]?.active_squad_member_count || 0,
    linkedCreatorsCount: roleRows[0]?.linked_creators_count || 0,
    linkedTradersCount: roleRows[0]?.linked_traders_count || 0,
    latestLinkedActivityAt: linkRows[0]?.latest_linked_activity_at || null,
  };
}

async function saveSignupNonce({ chainId, walletAddress, nonce }) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(
    `insert into public.auth_nonces (chain_id, address, nonce, expires_at)
     values ($1, $2, $3, $4)
     on conflict (chain_id, address)
     do update set nonce = excluded.nonce, expires_at = excluded.expires_at, used_at = null`,
    [chainId, walletAddress, nonce, expiresAt],
  );
  return expiresAt;
}

async function consumeSignupNonce({ chainId, walletAddress, nonce }) {
  const solana = isSolanaWallet(walletAddress);
  const { rows } = await pool.query(
    `select nonce, expires_at, used_at
       from public.auth_nonces
      where chain_id = $1
        and case when $3::boolean then address = $2 else lower(address) = lower($2) end
      limit 1`,
    [chainId, walletAddress, solana],
  );
  const row = rows[0];
  if (!row) throw new Error("Nonce not found. Request a new signup nonce and try again.");
  if (row.used_at) throw new Error("Nonce already used. Request a new signup nonce and try again.");
  if (String(row.nonce) !== String(nonce)) throw new Error("Nonce mismatch. Request a new signup nonce and try again.");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!exp || Date.now() > exp) throw new Error("Nonce expired. Request a new signup nonce and try again.");
  await pool.query(
    `update public.auth_nonces set used_at = now()
      where chain_id = $1
        and case when $3::boolean then address = $2 else lower(address) = lower($2) end`,
    [chainId, walletAddress, solana],
  );
}

export async function recruiterReferralCapture(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const code = normalizeCode(req.params?.code);
    const body = await readJson(req);
    const sessionToken = String(body.sessionToken || "").trim();
    const clientFingerprint = String(body.clientFingerprint || "").trim();
    const walletAddress = normalizeAddress(body.walletAddress) || null;
    if (!code) return json(res, 400, { error: "Missing recruiter code" });
    if (!sessionToken && !clientFingerprint && !walletAddress) return json(res, 400, { error: "Missing attribution identifier" });

    const recruiter = await findRecruiterByCode(code);
    if (!recruiter || recruiter.status !== "active") return json(res, 404, { error: "Recruiter not found", code: "RECRUITER_NOT_FOUND" });

    await pool.query(
      `insert into public.wallet_referral_attribution_windows (wallet_address, recruiter_id, client_fingerprint, session_token, expires_at, metadata, updated_at)
       values ($1, $2, $3, $4, now() + interval '30 days', $5::jsonb, now())`,
      [walletAddress, recruiter.id, clientFingerprint || null, sessionToken || null, JSON.stringify({ source: "frontend_referral_capture", userAgent: String(req.headers?.["user-agent"] || "").slice(0, 300) })],
    );

    return json(res, 200, { captured: true, recruiterCode: recruiter.code, recruiterDisplayName: recruiter.display_name, recruiterIsOg: Boolean(recruiter.is_og), walletAddress, expiresInDays: 30 });
  } catch (error) {
    console.error("[api/attribution referral capture]", error);
    if (schemaMissing(error)) return json(res, 200, { captured: false, warning: "Canonical reward attribution schema has not been applied yet." });
    return json(res, 500, { error: "Server error" });
  }
}

export async function attributionWalletConnect(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const walletAddress = normalizeAddress(body.walletAddress);
    const sessionToken = String(body.sessionToken || "").trim();
    const clientFingerprint = String(body.clientFingerprint || "").trim();
    const memberRole = normalizeMemberRole(body.memberRole);
    if (!walletAddress) return json(res, 400, { error: "Invalid or missing walletAddress" });

    // Owner / internal wallets (shared/ownerWallets.mjs) are never squad members of anyone.
    if (isOwnerWallet(walletAddress)) {
      return json(res, 200, { linked: false, blocked: true, code: "INTERNAL_WALLET_NOT_LINKABLE", state: publicState({ walletAddress }), reason: "This wallet belongs to MemeWarzone and cannot be linked to a recruiter." });
    }

    await pool.query(
      `insert into public.wallet_profiles (wallet_address)
       values ($1)
       on conflict (wallet_address)
       do update set updated_at = now()`,
      [walletAddress],
    );

    const recruiterWallet = await findRecruiterByWallet(walletAddress);
    if (recruiterWallet) {
      const existingState = await findWalletAttributionState(walletAddress);
      return json(res, 200, { linked: false, blocked: true, state: publicState({ walletAddress, state: existingState, recruiter: recruiterWallet }), reason: "Recruiter wallets cannot be added as squad members through recruiter referral cookies." });
    }

    const existingState = await findWalletAttributionState(walletAddress);
    if (existingState?.recruiter_link_state === "linked_unlocked" || existingState?.recruiter_link_state === "linked_locked") {
      const existingMembership = await findActiveSquadMembership(walletAddress).catch(() => null);
      let mergedRole = "";
      let roleUpdated = false;
      if (memberRole && existingMembership?.recruiter_id) {
        mergedRole = mergeMemberRole(existingMembership.member_role, memberRole);
        const currentRole = String(existingMembership.member_role || "member").trim().toLowerCase();
        if (mergedRole && mergedRole !== currentRole) {
          const solana = isSolanaWallet(walletAddress);
          await pool.query(
            `update public.wallet_squad_memberships
                set member_role = $1,
                    link_source = coalesce(nullif(link_source, ''), 'referral_cookie'),
                    updated_at = now()
              where case when $3::boolean then wallet_address = $2 else lower(wallet_address) = lower($2) end
                and is_active = true`,
            [mergedRole, walletAddress, solana],
          );
          roleUpdated = true;
        }
      }
      const updatedState = await findWalletAttributionState(walletAddress);
      return json(res, 200, {
        linked: Boolean(updatedState?.recruiter_id),
        locked: Boolean(updatedState?.has_activity || updatedState?.locked_at),
        memberRole: mergedRole || existingMembership?.member_role || null,
        state: publicState({ walletAddress, state: updatedState }),
        reason: roleUpdated
          ? `Existing squad membership role was upgraded to ${mergedRole}.`
          : "Existing canonical wallet attribution is already linked or locked.",
      });
    }

    const window = await findLatestWindow({ sessionToken, clientFingerprint, walletAddress });
    const recruiter = window?.recruiter_id ? await findRecruiterByCode(window.code) : null;
    if (!window || !recruiter || recruiter.status !== "active") return json(res, 200, { linked: false, state: publicState({ walletAddress }), reason: "No active referral attribution window found for this wallet." });

    // A recruiter tied to an owner wallet is internal (a founder test account): no new squad members.
    if (internalRecruiterLabel({ walletAddress: recruiter.wallet_address, signup: recruiter.metadata?.signup })) {
      return json(res, 200, { linked: false, blocked: true, code: "INTERNAL_RECRUITER_NOT_LINKABLE", state: publicState({ walletAddress }), reason: "This recruiter is an internal MemeWarzone account and does not take squad members." });
    }

    if (await isSameWalletCluster(walletAddress, recruiter.wallet_address)) {
      return json(res, 409, {
        linked: false,
        blocked: true,
        code: "RECRUITER_CLUSTER_SELF_REFERRAL_BLOCKED",
        state: publicState({ walletAddress }),
        reason: "This wallet is in the same security cluster as the recruiter wallet and cannot join that recruiter squad.",
      });
    }

    if (!memberRole) {
      return json(res, 200, {
        linked: false,
        needsRoleSelection: true,
        state: publicState({ walletAddress }),
        recruiter: { code: recruiter.code, displayName: recruiter.display_name, isOg: Boolean(recruiter.is_og) },
        reason: "Choose whether this wallet joins as a creator, trader, or both before locking recruiter attribution.",
      });
    }

    // One connection for the whole link: BEGIN on the pool would land on an arbitrary
    // connection, so the three writes were never really one transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `insert into public.wallet_recruiter_links (wallet_address, recruiter_id, link_source)
         values ($1, $2, 'referral_cookie')
         on conflict (wallet_address) where is_active = true
         do nothing`,
        [walletAddress, recruiter.id],
      );
      await client.query(
        `insert into public.wallet_squad_memberships (wallet_address, recruiter_id, member_role, link_source)
         values ($1, $2, $3, 'referral_cookie')
         on conflict (wallet_address) where is_active = true
         do update set
           member_role = case
             when lower(coalesce(public.wallet_squad_memberships.member_role, 'member')) = 'both'
               or excluded.member_role = 'both' then 'both'
             when lower(coalesce(public.wallet_squad_memberships.member_role, 'member')) in ('creator','trader')
               and lower(public.wallet_squad_memberships.member_role) <> excluded.member_role then 'both'
             else excluded.member_role
           end,
           link_source = excluded.link_source,
           updated_at = now()`,
        [walletAddress, recruiter.id, memberRole],
      );
      await client.query(`update public.wallet_referral_attribution_windows set wallet_address = coalesce(wallet_address, $1), consumed_at = now(), updated_at = now() where id = $2`, [walletAddress, window.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const updatedState = await findWalletAttributionState(walletAddress);
    const membership = await findActiveSquadMembership(walletAddress).catch(() => null);
    return json(res, 200, { linked: Boolean(updatedState?.recruiter_id), memberRole: membership?.member_role || memberRole, state: publicState({ walletAddress, state: updatedState, recruiter }) });
  } catch (error) {
    console.error("[api/attribution wallet-connect]", error);
    if (schemaMissing(error)) {
      const body = await readJson(req).catch(() => ({}));
      const walletAddress = normalizeAddress(body.walletAddress);
      return json(res, 200, { linked: false, state: publicState({ walletAddress }), warning: "Canonical reward attribution schema has not been applied yet." });
    }
    return json(res, 500, { error: "Server error" });
  }
}

export async function attributionWallet(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const walletAddress = normalizeAddress(req.params?.wallet);
    if (!walletAddress) return json(res, 400, { error: "Invalid wallet address" });
    const [state, membership, recruiter] = await Promise.all([
      findWalletAttributionState(walletAddress),
      findActiveSquadMembership(walletAddress).catch(() => null),
      findRecruiterByWallet(walletAddress).catch(() => null),
    ]);
    return json(res, 200, { state: publicState({ walletAddress, state, membership, recruiter }), materializedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[api/attribution wallet]", error);
    if (schemaMissing(error)) {
      const walletAddress = normalizeAddress(req.params?.wallet);
      return json(res, 200, { state: publicState({ walletAddress }), warning: "Canonical reward attribution schema has not been applied yet." });
    }
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterWalletSummary(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const wallet = normalizeAddress(req.params?.wallet);
    if (!wallet) return json(res, 400, { error: "Invalid wallet address" });
    const recruiter = await findRecruiterByWallet(wallet);
    if (!recruiter) return json(res, 404, { error: "Recruiter not found", code: "RECRUITER_NOT_FOUND" });
    const stats = await getRecruiterStats(recruiter.id, recruiter.wallet_address);
    return json(res, 200, recruiterSummaryShape(recruiter, stats));
  } catch (error) {
    console.error("[api/recruiter wallet summary]", error);
    if (schemaMissing(error)) return json(res, 404, { error: "Recruiter not found", code: "RECRUITER_NOT_FOUND" });
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterSummary(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const code = normalizeCode(req.params?.code);
    if (!code) return json(res, 400, { error: "Missing recruiter code" });
    const recruiter = await findRecruiterByCode(code);
    if (!recruiter) return json(res, 404, { error: "Recruiter not found", code: "RECRUITER_NOT_FOUND" });
    const stats = await getRecruiterStats(recruiter.id, recruiter.wallet_address);
    return json(res, 200, recruiterSummaryShape(recruiter, stats));
  } catch (error) {
    console.error("[api/recruiter summary]", error);
    if (schemaMissing(error)) return json(res, 404, { error: "Recruiter not found", code: "RECRUITER_NOT_FOUND" });
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiters(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const q = getQuery(req);
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 250);
    const status = String(q.status || "active").trim().toLowerCase();
    const { rows } = await pool.query(
      `select r.id, r.wallet_address, r.code, r.display_name, r.is_og, r.status, r.closed_at, r.metadata, r.created_at, r.updated_at,
              count(distinct l.wallet_address)::int as linked_wallet_count,
              count(distinct s.wallet_address)::int as active_squad_member_count,
              count(distinct s.wallet_address) filter (where s.member_role in ('creator','both'))::int as linked_creators_count,
              count(distinct s.wallet_address) filter (where s.member_role in ('trader','both'))::int as linked_traders_count,
              max(l.linked_at) as latest_linked_activity_at
         from public.recruiters r
         left join public.wallet_recruiter_links l on l.recruiter_id = r.id and l.is_active = true and lower(l.wallet_address) <> lower(r.wallet_address)
         left join public.wallet_squad_memberships s on s.recruiter_id = r.id and s.is_active = true and lower(s.wallet_address) <> lower(r.wallet_address)
         left join public.wallet_risk_profiles lwr on lower(lwr.wallet_address) = lower(l.wallet_address)
         left join public.wallet_risk_profiles swr on lower(swr.wallet_address) = lower(s.wallet_address)
         left join public.wallet_risk_profiles rwr on lower(rwr.wallet_address) = lower(r.wallet_address)
        where ($1::text = 'all' or r.status = $1::text)
          and not (lwr.cluster_id is not null and rwr.cluster_id is not null and lwr.cluster_id = rwr.cluster_id)
          and not (swr.cluster_id is not null and rwr.cluster_id is not null and swr.cluster_id = rwr.cluster_id)
        group by r.id
        order by r.is_og desc, linked_wallet_count desc, r.created_at asc
        limit $2`,
      [status || "active", limit],
    );
    return json(res, 200, {
      recruiters: rows.map((r) => recruiterSummaryShape(r, { linkedWalletCount: r.linked_wallet_count, linkedCreatorsCount: r.linked_creators_count, linkedTradersCount: r.linked_traders_count, activeSquadMemberCount: r.active_squad_member_count, latestLinkedActivityAt: r.latest_linked_activity_at })),
      limit,
      status,
      materializedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/recruiters]", error);
    if (schemaMissing(error)) return json(res, 200, { recruiters: [], warning: "Canonical reward attribution schema has not been applied yet." });
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterSignupStatus(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const q = getQuery(req);
    const walletAddress = normalizeAddress(q.walletAddress);
    if (!walletAddress) return json(res, 400, { error: "Invalid or missing walletAddress" });
    const recruiter = await findRecruiterByWallet(walletAddress);
    return json(res, 200, { walletAddress, isRecruiter: Boolean(recruiter), recruiter: recruiter ? recruiterSummaryShape(recruiter, await getRecruiterStats(recruiter.id, recruiter.wallet_address)) : null, canStartSignup: !recruiter, signupApiAvailable: true });
  } catch (error) {
    console.error("[api/recruiter signup status]", error);
    if (schemaMissing(error)) {
      const q = getQuery(req);
      return json(res, 200, { walletAddress: normalizeAddress(q.walletAddress), isRecruiter: false, recruiter: null, canStartSignup: true, signupApiAvailable: false, warning: "Canonical reward attribution schema has not been applied yet." });
    }
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterSignupCodeAvailability(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    const q = getQuery(req);
    const code = normalizeCode(q.code);
    if (!code || code.length < 2) return json(res, 200, { code, isAvailable: false, checkedVia: "signup-endpoint", message: "Use at least 2 lowercase letters, numbers, dashes, or underscores." });
    const existing = await findRecruiterByCode(code);
    return json(res, 200, { code, isAvailable: !existing, checkedVia: "signup-endpoint", message: existing ? "This recruiter code is already taken." : "This recruiter code is available." });
  } catch (error) {
    console.error("[api/recruiter signup code availability]", error);
    if (schemaMissing(error)) {
      const q = getQuery(req);
      return json(res, 200, { code: normalizeCode(q.code), isAvailable: null, checkedVia: "unavailable", message: "Canonical reward attribution schema has not been applied yet." });
    }
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterSignupNonce(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const walletAddress = normalizeAddress(body.walletAddress);
    const chainId = Number(body.chainId || (isSolanaWallet(walletAddress) ? 101 : 97));
    if (!walletAddress) return json(res, 400, { error: "Invalid or missing walletAddress" });
    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (isSolanaWallet(walletAddress) && chainId !== 101 && chainId !== 102) return json(res, 400, { error: "Invalid Solana chainId" });
    const nonce = makeNonce();
    const expiresAt = await saveSignupNonce({ chainId, walletAddress, nonce });
    return json(res, 200, { nonce, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("[api/recruiter signup nonce]", error);
    if (schemaMissing(error)) return json(res, 503, { error: "Canonical reward attribution schema has not been applied yet." });
    return json(res, 500, { error: "Server error" });
  }
}

export async function recruiterSignupSubmit(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const body = await readJson(req);
    const walletAddress = normalizeAddress(body.walletAddress);
    const chainId = Number(body.chainId || (isSolanaWallet(walletAddress) ? 101 : 97));
    const desiredCode = normalizeCode(body.desiredCode);
    const displayName = normalizeText(body.displayName, 40);
    const email = normalizeText(body.email, 120);
    const pitch = normalizeText(body.pitch, 1000);
    const nonce = String(body.nonce || "").trim();
    const signature = String(body.signature || "").trim();

    if (!walletAddress) return json(res, 400, { error: "Invalid or missing walletAddress" });
    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (isSolanaWallet(walletAddress) && chainId !== 101 && chainId !== 102) return json(res, 400, { error: "Invalid Solana chainId" });
    if (!displayName) return json(res, 400, { error: "Display name is required" });
    if (!desiredCode || desiredCode.length < 2) return json(res, 400, { error: "Recruiter code is invalid" });
    if (!email) return json(res, 400, { error: "Email is required" });
    if (!pitch) return json(res, 400, { error: "Pitch is required" });
    if (!body.acceptTerms) return json(res, 400, { error: "Recruiter terms must be accepted" });
    if (!nonce) return json(res, 400, { error: "Nonce missing" });
    if (!signature) return json(res, 400, { error: "Signature missing" });

    const existingWallet = await findRecruiterByWallet(walletAddress);
    if (existingWallet) return json(res, 409, { error: "This wallet is already a recruiter" });
    const existingCode = await findRecruiterByCode(desiredCode);
    if (existingCode) return json(res, 409, { error: "This recruiter code is already taken" });

    await consumeSignupNonce({ chainId, walletAddress, nonce });
    const message = buildRecruiterSignupMessage({ chainId, walletAddress, nonce, displayName, desiredCode, email, telegram: body.telegram, discord: body.discord, xHandle: body.xHandle, pitch });
    if (!verifySignupSignature({ walletAddress, message, signature })) return json(res, 401, { error: "Invalid signature" });

    const isOg = preliveRecruitersAreOg();
    const metadata = {
      signup: {
        chain: isSolanaWallet(walletAddress) ? "solana" : "bnb",
        ...(isSolanaWallet(walletAddress) ? { solanaWalletAddress: walletAddress } : {}),
        email,
        telegram: normalizeText(body.telegram, 80),
        discord: normalizeText(body.discord, 80),
        xHandle: normalizeText(body.xHandle, 80),
        pitch,
        acceptedTermsAt: new Date().toISOString(),
        preliveOg: isOg,
      },
    };
    const { rows } = await pool.query(
      `insert into public.recruiters (wallet_address, code, display_name, is_og, status, metadata)
       values ($1, $2, $3, $4, 'active', $5::jsonb)
       returning id, wallet_address, code, display_name, is_og, status, closed_at, metadata, created_at, updated_at`,
      [walletAddress, desiredCode, displayName, isOg, JSON.stringify(metadata)],
    );

    return json(res, 200, { ok: true, recruiter: recruiterSummaryShape(rows[0]) });
  } catch (error) {
    console.error("[api/recruiter signup submit]", error);
    const message = String(error?.message || "");
    if (/nonce|signature/i.test(message)) return json(res, 401, { error: message });
    if (schemaMissing(error)) return json(res, 503, { error: "Canonical reward attribution schema has not been applied yet." });
    if (error?.code === "23505") return json(res, 409, { error: "Recruiter wallet or code already exists" });
    return json(res, 500, { error: "Server error" });
  }
}
