// E18: a holder payout (EVM 'airdrop_holders', Solana DBC 'dbc_holders' / code 2) never starts the
// 14-day airdrop cooldown; trader (code 0) and creator (code 1) wins still do.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AIRDROP_COOLDOWN_SQL,
  HOLDER_PAYOUT_PROGRAMS,
  countsTowardAirdropCooldown,
  exclusionSets,
  isWalletExcluded,
} from "./candidates.mjs";
import { SOLANA_AIRDROP_PROGRAM_CODES } from "./solanaAirdrop.mjs";
import { airdropProgramLabel, airdropProgramKind, airdropRankNoun } from "../../src/lib/airdropProgramLabel.mjs";

const DAY = 86_400_000;
const START = new Date("2026-10-05T00:00:00Z");
const lastWeek = new Date(START.getTime() - 5 * DAY);

// A fake pg client. The cooldown query is answered by applying its parameters to fixture reward_ledger
// rows the way the SQL does (the SQL itself was run against Postgres; see the commit message).
function fakeClient(ledger) {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      seen.push({ sql, params });
      if (!sql.includes("from public.reward_ledger")) return { rows: [] };
      const [chain, start, excludedPrograms, excludedCode] = params;
      const rows = ledger
        .filter((r) => r.chain === chain && r.created_at >= new Date(start.getTime() - 14 * DAY) && r.created_at < start)
        .filter((r) => !["cancelled", "expired"].includes(r.status))
        .filter((r) => !excludedPrograms.includes(String(r.metadata?.program ?? "")))
        .filter((r) => String(r.metadata?.programCode ?? "") !== excludedCode)
        .map((r) => ({ wallet: chain === "101" ? r.wallet_address : r.wallet_address.toLowerCase() }));
      return { rows };
    },
  };
}

const row = (wallet_address, chain, metadata) => ({ wallet_address, chain, metadata, created_at: lastWeek, status: "claimable" });

test("the cooldown SQL filters holder programs and code 2, and is parameterised with them", async () => {
  assert.match(AIRDROP_COOLDOWN_SQL, /coalesce\(metadata->>'program',''\) <> all\(\$3::text\[\]\)/);
  assert.match(AIRDROP_COOLDOWN_SQL, /coalesce\(metadata->>'programCode',''\) <> \$4/);
  assert.match(AIRDROP_COOLDOWN_SQL, /interval '14 days'/);
  const client = fakeClient([]);
  await exclusionSets(client, { chainId: 56, start: START, end: new Date(START.getTime() + 7 * DAY) });
  const q = client.seen.find((s) => s.sql.includes("from public.reward_ledger"));
  assert.deepEqual(q.params.slice(2), [["airdrop_holders", "dbc_holders"], "2"]);
  assert.equal(String(SOLANA_AIRDROP_PROGRAM_CODES.dbc_holders), q.params[3]);
});

test("EVM: a wallet paid only as a holder last week is still eligible; trader and creator winners are excluded", async () => {
  const client = fakeClient([
    row("0xHOLDER", "56", { role: "Holder", program: "airdrop_holders" }),
    row("0xTRADER", "56", { program: "airdrop_trader" }),
    row("0xCREATOR", "56", { role: "Creator", program: "airdrop_creator" }),
    row("0xLEGACY", "56", {}),
  ]);
  const ex = await exclusionSets(client, { chainId: 56, start: START, end: new Date(START.getTime() + 7 * DAY) });
  assert.equal(isWalletExcluded(ex, "0xholder"), false);
  assert.equal(isWalletExcluded(ex, "0xtrader"), true);
  assert.equal(isWalletExcluded(ex, "0xcreator"), true);
  assert.equal(isWalletExcluded(ex, "0xlegacy"), true, "rows without a program keep counting as before");
});

test("Solana: a code-2 DBC holder leaf does not start the cooldown; code 0 and code 1 do", async () => {
  const client = fakeClient([
    row("HoLdEr1111", "101", { program: "dbc_holders", programCode: 2 }),
    row("TrAdEr1111", "101", { program: "airdrop_trader", programCode: 0 }),
    row("CrEaToR111", "101", { program: "airdrop_creator", programCode: 1 }),
  ]);
  const ex = await exclusionSets(client, { chainId: 101, start: START, end: new Date(START.getTime() + 7 * DAY) });
  assert.equal(isWalletExcluded(ex, "HoLdEr1111"), false);
  assert.equal(isWalletExcluded(ex, "TrAdEr1111"), true);
  assert.equal(isWalletExcluded(ex, "CrEaToR111"), true);
});

test("a wallet that was both a holder and a trader winner stays excluded", async () => {
  const client = fakeClient([
    row("0xBOTH", "56", { program: "airdrop_holders" }),
    row("0xBOTH", "56", { program: "airdrop_trader" }),
  ]);
  const ex = await exclusionSets(client, { chainId: 56, start: START, end: new Date(START.getTime() + 7 * DAY) });
  assert.equal(isWalletExcluded(ex, "0xboth"), true);
});

test("countsTowardAirdropCooldown mirrors the SQL", () => {
  assert.deepEqual([...HOLDER_PAYOUT_PROGRAMS], ["airdrop_holders", "dbc_holders"]);
  assert.equal(countsTowardAirdropCooldown({ program: "airdrop_holders" }), false);
  assert.equal(countsTowardAirdropCooldown({ program: "dbc_holders", programCode: 2 }), false);
  assert.equal(countsTowardAirdropCooldown({ programCode: 2 }), false);
  assert.equal(countsTowardAirdropCooldown({ programCode: "2" }), false);
  assert.equal(countsTowardAirdropCooldown({ program: "airdrop_trader", programCode: 0 }), true);
  assert.equal(countsTowardAirdropCooldown({ program: "airdrop_creator", programCode: 1 }), true);
  assert.equal(countsTowardAirdropCooldown({}), true);
  assert.equal(countsTowardAirdropCooldown(null), true);
});

test("holder payouts are labelled as holder payouts, not draw wins", () => {
  assert.equal(airdropProgramLabel("airdrop_holders"), "Holder payout");
  assert.equal(airdropProgramLabel("dbc_holders"), "Holder payout");
  assert.equal(airdropProgramLabel("airdrop_trader"), "Trader draw");
  assert.equal(airdropProgramLabel("airdrop_creator"), "Creator draw");
  assert.equal(airdropProgramKind("airdrop_creator"), "Creator");
  assert.equal(airdropProgramKind("airdrop_trader"), "Trader");
  assert.equal(airdropRankNoun("dbc_holders"), "payout");
  assert.equal(airdropRankNoun("airdrop_trader"), "winner");
});
