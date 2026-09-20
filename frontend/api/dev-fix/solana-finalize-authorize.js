/**
 * Issues the route authorization for finalize_campaign_launch, for any campaign
 * that has been created but not yet finalized.
 *
 * There are three ways a campaign gets created — Direct Deploy, Draft Deploy
 * ("Push Live") and a scheduled launch — and all three need the same second
 * transaction. Rather than thread the authorization through each flow's own
 * response, they all ask here once the create is confirmed. That also makes this
 * the recovery path: a launch whose creator closed the tab between the two
 * transactions can be finished later by anyone willing to pay the rent.
 *
 * Everything that decides the token's identity is read from our own records and
 * from chain state, never from the request. The caller chooses which campaign to
 * finalize and who pays; it does not get to choose the name. That matters
 * because finalize revokes the mint authority immediately after writing the
 * metadata, so the first name to land is permanent.
 */
import { pool } from "../../server/db.js";
import { badMethod, json, readJson } from "../../server/http.js";
import { decodeCampaignAccount, publicKeyString } from "./solana-v4-primitives.js";
import { issueFinalizeLaunchAuthorization } from "./solana-finalize-launch.js";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function getAccounts(rpcUrl, addresses) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || "Solana RPC error");
  return payload?.result?.value || [];
}

/**
 * A revoked mint authority is the on-chain record that finalize already ran.
 * The first four bytes of an SPL mint are the COption tag for that authority:
 * zero means None.
 */
function mintAuthorityRevoked(account) {
  if (!account) return false;
  const data = Buffer.from(account.data?.[0] || "", "base64");
  if (data.length < 4) return false;
  return data.readUInt32LE(0) === 0;
}

export async function solanaFinalizeAuthorize(req, res) {
  if (!methodAllowed(req, res)) return;
  try {
    const body = await readJson(req);
    let campaignAddress;
    try {
      campaignAddress = publicKeyString(body.campaignAddress, "campaignAddress");
    } catch {
      return json(res, 400, {
        ok: false,
        error: "campaignAddress must be a Solana address.",
        code: "SOLANA_FINALIZE_CAMPAIGN_INVALID",
      });
    }

    const rpcUrl = requiredEnv("SOLANA_RPC_URL");
    const programId = requiredEnv("SOLANA_LAUNCHPAD_PROGRAM_ID");

    const [campaignAccount] = await getAccounts(rpcUrl, [campaignAddress]);
    if (!campaignAccount || campaignAccount.owner !== programId) {
      return json(res, 409, {
        ok: false,
        error: "Campaign is not on-chain yet, or is not a launchpad campaign.",
        code: "SOLANA_FINALIZE_CAMPAIGN_NOT_FOUND",
      });
    }

    const decoded = decodeCampaignAccount(Buffer.from(campaignAccount.data[0], "base64"));
    const [mintAccount] = await getAccounts(rpcUrl, [decoded.mint]);
    if (!mintAccount || mintAccount.owner !== TOKEN_PROGRAM_ID) {
      return json(res, 409, {
        ok: false,
        error: "Campaign mint is not on-chain yet.",
        code: "SOLANA_FINALIZE_MINT_NOT_FOUND",
      });
    }
    if (mintAuthorityRevoked(mintAccount)) {
      // Not an error worth alarming a client over: it means the launch is done.
      return json(res, 200, {
        ok: true,
        alreadyFinalized: true,
        campaignAddress,
        mintAddress: decoded.mint,
        authorization: null,
      });
    }

    // The name is ours, not the caller's. A campaign we have no record of is one
    // we cannot name, and signing a caller-supplied name here would hand away
    // the only thing the route signature is protecting.
    const row = await pool.query(
      `select name, symbol from public.campaigns
        where campaign_address = $1 or token_address = $2
        limit 1`,
      [campaignAddress, decoded.mint],
    );
    const name = String(row.rows[0]?.name || "").trim();
    const symbol = String(row.rows[0]?.symbol || "").trim();
    if (!name || !symbol) {
      return json(res, 409, {
        ok: false,
        error: "No stored name and ticker for this campaign, so it cannot be named.",
        code: "SOLANA_FINALIZE_METADATA_UNKNOWN",
      });
    }

    const authorization = issueFinalizeLaunchAuthorization({
      programId,
      routeSignerSecret: requiredEnv("SOLANA_ROUTE_SIGNER_SECRET_KEY"),
      campaign: campaignAddress,
      mint: decoded.mint,
      creator: decoded.creator,
      campaignId: decoded.campaignId,
      name,
      symbol,
    });

    return json(res, 200, {
      ok: true,
      alreadyFinalized: false,
      campaignAddress,
      mintAddress: decoded.mint,
      authorization,
    });
  } catch (error) {
    console.error("[solana/finalize-authorize]", error?.message || error);
    return json(res, 500, {
      ok: false,
      error: "Could not issue a finalize authorization.",
      code: "SOLANA_FINALIZE_AUTHORIZE_FAILED",
    });
  }
}

function methodAllowed(req, res) {
  if (String(req.method || "").toUpperCase() === "POST") return true;
  badMethod(res);
  return false;
}

export default solanaFinalizeAuthorize;
