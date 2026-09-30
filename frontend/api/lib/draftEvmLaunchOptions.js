import { FEE_CHOICE_NAMES, Gen6CreateOptionError, hasGen6CreateFields, parseGen6CreateOptions } from "./evmLaunchGen6.js";

/**
 * Generation 6 EVM create options saved on a draft (table campaign_draft_evm_launch_options,
 * db/migrations/20260930_100001). Only EVM chains; Solana drafts keep their own dbc_* columns.
 * A missing table (migration not applied yet) reads as "no options" and a write reports
 * `persisted: false`, so nothing that works today starts failing before the migration lands.
 */

export const EVM_LAUNCH_OPTION_CHAIN_IDS = new Set([56, 97, 4663, 46630, 31337]);

function missingRelation(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

export function wantsEvmLaunchOptions(body, chainId) {
  return EVM_LAUNCH_OPTION_CHAIN_IDS.has(Number(chainId)) && hasGen6CreateFields(body || {});
}

/** Row -> the fields prepareGen6CreateOptions reads (max cost is priced at arm time). */
export function evmLaunchOptionsSource(row) {
  if (!row) return null;
  return {
    feeChoice: Number(row.fee_choice),
    feeCreatorPct: Number(row.fee_creator_pct || 0),
    firstBuyTokens: String(row.first_buy_tokens ?? "0"),
  };
}

export function attachDraftEvmLaunchOptions(draft, row) {
  if (!draft || !row) return draft;
  const choice = Number(row.fee_choice);
  return {
    ...draft,
    evmLaunchOptions: {
      feeChoice: choice,
      feeChoiceName: FEE_CHOICE_NAMES[choice] || null,
      feeCreatorPct: Number(row.fee_creator_pct || 0),
      firstBuyTokens: String(row.first_buy_tokens ?? "0"),
    },
  };
}

export async function loadDraftEvmLaunchOptions(db, draftIds) {
  const ids = Array.from(new Set((draftIds || []).map((id) => String(id || "")).filter(Boolean)));
  const out = new Map();
  if (!db || !ids.length) return out;
  try {
    const result = await db.query(
      `select draft_id::text as draft_id, chain_id, fee_choice, fee_creator_pct, first_buy_tokens::text as first_buy_tokens
         from public.campaign_draft_evm_launch_options
        where draft_id::text = any($1::text[])`,
      [ids],
    );
    for (const row of result.rows) out.set(String(row.draft_id), row);
  } catch (error) {
    if (!missingRelation(error)) throw error;
  }
  return out;
}

/**
 * Validate (shape only; the curve and the live target are checked when the draft is armed) and upsert.
 * Locked once the draft has an on-chain campaign: the options were signed into it.
 */
export async function persistDraftEvmLaunchOptions(db, draftId, body) {
  if (!db) throw new Error("Draft launch options need DATABASE_URL-backed persistence.");
  const draftResult = await db.query(
    "select id::text as id, chain_id, status, campaign_address from public.campaign_drafts where id::text=$1 limit 1",
    [String(draftId)],
  );
  const draft = draftResult.rows[0];
  if (!draft) throw new Error("Draft not found while saving launch options.");
  const chainId = Number(draft.chain_id);
  // Solana DBC drafts send feeChoice too and store it in their own dbc_* columns: not ours, no-op.
  if (!EVM_LAUNCH_OPTION_CHAIN_IDS.has(chainId)) return null;
  if (draft.campaign_address || ["deployed", "scheduled", "live"].includes(String(draft.status || "").toLowerCase())) {
    throw new Error("Launch options are locked once the campaign is on chain.");
  }
  const parsed = parseGen6CreateOptions(body, { autoMaxCost: true });
  try {
    const result = await db.query(
      `insert into public.campaign_draft_evm_launch_options(
         draft_id, chain_id, fee_choice, fee_creator_pct, first_buy_tokens, updated_at
       ) values ($1::uuid, $2, $3, $4, $5::numeric, now())
       on conflict (draft_id) do update set
         chain_id = excluded.chain_id,
         fee_choice = excluded.fee_choice,
         fee_creator_pct = excluded.fee_creator_pct,
         first_buy_tokens = excluded.first_buy_tokens,
         updated_at = now()
       returning draft_id::text as draft_id, chain_id, fee_choice, fee_creator_pct, first_buy_tokens::text as first_buy_tokens`,
      [String(draftId), chainId, parsed.feeChoice, parsed.feeCreatorPct, parsed.firstBuyTokens.toString()],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (missingRelation(error)) return null;
    throw error;
  }
}

export { Gen6CreateOptionError };
