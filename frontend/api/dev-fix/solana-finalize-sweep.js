/**
 * Finish every Solana launch that was created but never finalized.
 *
 * A launch takes two transactions: create_campaign mints the supply, and
 * finalize_campaign_launch writes the Metaplex metadata, revokes the mint
 * authority and creates the fee accounts. Until the second lands the token has
 * no name in any wallet and cannot trade.
 *
 * The browser sends the second one during the launch flow. It does not always
 * get there. A creator closes the tab, a wallet prompt is dismissed, a code path
 * returns early — on mainnet a launch completed its create, navigated to the
 * token page, and left the token stranded with no error anyone could see. The
 * browser being the only thing that can finish a launch is the problem; this
 * removes that dependency.
 *
 * Nothing here can choose what a token is called. The name and symbol come from
 * our own records and the creator from chain state, exactly as
 * /api/solana/finalize-authorize does, and the route signature still binds them.
 * The sweep only decides *when* to send.
 *
 * It is a no-op unless SOLANA_FINALIZE_PAYER_SECRET_KEY is set. That wallet pays
 * about 0.003 SOL per launch, nearly all of it rent for the three accounts it
 * creates, and it needs no other authority.
 */
import { pool } from "../../server/db.js";
import { decodeCampaignAccount } from "./solana-v4-primitives.js";
import { sendFinalizeCampaignLaunch, deriveFinalizeAccounts } from "./solana-finalize-launch.js";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_CHAIN_ID = 101;

/** How far back to look. A campaign older than this was either finished or abandoned long ago. */
const DEFAULT_LOOKBACK_HOURS = 72;
/** Bounded so one sweep cannot spend the payer dry if something is systemically wrong. */
const DEFAULT_MAX_PER_RUN = 10;

function env(name) {
  return String(process.env[name] || "").trim();
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function rpc(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || "Solana RPC error");
  return payload?.result;
}

/**
 * A mint whose authority is still set has not been finalized. That is chain
 * state, not a cached flag: Campaign.mint_authority_revoked was shipped wrong
 * once already, so it is deliberately not consulted here.
 */
function mintAuthorityLive(account) {
  if (!account) return false;
  const data = Buffer.from(account.data?.[0] || "", "base64");
  if (data.length < 4) return false;
  return data.readUInt32LE(0) === 1;
}

export async function findUnfinalizedCampaigns({ lookbackHours = DEFAULT_LOOKBACK_HOURS, limit = 50 } = {}) {
  const rpcUrl = requiredEnv("SOLANA_RPC_URL");
  const programId = requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID");

  const rows = await pool.query(
    `select campaign_address, token_address, name, symbol, created_at
       from public.campaigns
      where chain_id = $1
        and campaign_address is not null
        and token_address is not null
        and name is not null and name <> ''
        and symbol is not null and symbol <> ''
        and created_at > now() - ($2 || ' hours')::interval
      order by created_at desc
      limit $3`,
    [SOLANA_CHAIN_ID, String(lookbackHours), limit],
  );
  if (!rows.rows.length) return [];

  // One RPC round trip for every mint rather than one per campaign.
  const mints = rows.rows.map((row) => row.token_address);
  const accounts = await rpc(rpcUrl, "getMultipleAccounts", [
    mints,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const values = accounts?.value || [];

  const pending = [];
  for (let index = 0; index < rows.rows.length; index += 1) {
    const account = values[index];
    if (!account || account.owner !== TOKEN_PROGRAM_ID) continue;
    if (!mintAuthorityLive(account)) continue; // already finalized
    pending.push({ ...rows.rows[index], programId });
  }
  return pending;
}

/**
 * Finalize one campaign. Reads the creator and campaign id from chain state so
 * a stale or wrong database row cannot redirect the transaction.
 */
export async function finalizeOne(campaignAddress) {
  const rpcUrl = requiredEnv("SOLANA_RPC_URL");
  const programId = requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID");
  const payerSecret = requiredEnv("SOLANA_FINALIZE_PAYER_SECRET_KEY");

  const result = await rpc(rpcUrl, "getMultipleAccounts", [
    [campaignAddress],
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const account = result?.value?.[0];
  if (!account || account.owner !== programId) {
    throw new Error("campaign is not a launchpad campaign on chain");
  }
  const decoded = decodeCampaignAccount(Buffer.from(account.data[0], "base64"));

  const row = await pool.query(
    `select name, symbol from public.campaigns
      where campaign_address = $1 or token_address = $2
      limit 1`,
    [campaignAddress, decoded.mint],
  );
  const name = String(row.rows[0]?.name || "").trim();
  const symbol = String(row.rows[0]?.symbol || "").trim();
  if (!name || !symbol) throw new Error("no stored name and ticker for this campaign");

  const derived = deriveFinalizeAccounts({ programId, campaign: campaignAddress, mint: decoded.mint });
  return sendFinalizeCampaignLaunch({
    rpcUrl,
    programId,
    routeSignerSecret: requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY"),
    payerSecret,
    campaign: campaignAddress,
    mint: decoded.mint,
    creator: decoded.creator,
    campaignId: decoded.campaignId,
    name,
    symbol,
    ...derived,
  });
}

export async function runFinalizeSweep({
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  maxPerRun = DEFAULT_MAX_PER_RUN,
  dryRun = false,
} = {}) {
  if (!env("SOLANA_FINALIZE_PAYER_SECRET_KEY")) {
    return { enabled: false, reason: "SOLANA_FINALIZE_PAYER_SECRET_KEY is not set", pending: [], finalized: [], failed: [] };
  }

  const pending = await findUnfinalizedCampaigns({ lookbackHours });
  const finalized = [];
  const failed = [];

  for (const campaign of pending.slice(0, maxPerRun)) {
    if (dryRun) continue;
    try {
      const result = await finalizeOne(campaign.campaign_address);
      finalized.push({ campaign: campaign.campaign_address, name: campaign.name, signature: result.signature });
      console.log(`[finalize-sweep] finalized ${campaign.campaign_address} (${campaign.name}) ${result.signature}`);
    } catch (error) {
      const message = String(error?.message || error);
      failed.push({ campaign: campaign.campaign_address, error: message });
      console.error(`[finalize-sweep] ${campaign.campaign_address}: ${message}`);
    }
  }

  return {
    enabled: true,
    dryRun,
    pendingCount: pending.length,
    pending: pending.map((p) => ({ campaign: p.campaign_address, name: p.name, createdAt: p.created_at })),
    finalized,
    failed,
  };
}

export default runFinalizeSweep;
