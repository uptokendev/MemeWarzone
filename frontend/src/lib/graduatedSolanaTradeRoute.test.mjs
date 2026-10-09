import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  assertGraduatedSolanaQuote,
  graduatedSolanaTradeItem,
  graduatedSolanaTradeRoute,
  solanaGraduatedImportRouteEnabled,
} from "./graduatedSolanaTradeRoute.mjs";

const ON = { VITE_SOLANA_GRADUATED_IMPORT_ROUTE: "1" };

test("bonding coins never take the import route, switch on or off", () => {
  assert.equal(graduatedSolanaTradeRoute({ isDbc: false, curveGraduated: false }, ON), "bonding");
  assert.equal(graduatedSolanaTradeRoute({ isDbc: true, dbcMigrated: false, curveGraduated: true }, ON), "bonding");
});

test("graduated launchpad and migrated DBC coins: import route only while the switch is on", () => {
  assert.equal(graduatedSolanaTradeRoute({ isDbc: false, curveGraduated: true }, ON), "import");
  assert.equal(graduatedSolanaTradeRoute({ isDbc: true, dbcMigrated: true }, ON), "import");
  assert.equal(graduatedSolanaTradeRoute({ isDbc: false, curveGraduated: true }, {}), "direct-pool");
  assert.equal(solanaGraduatedImportRouteEnabled({ VITE_SOLANA_GRADUATED_IMPORT_ROUTE: "false" }), false);
});

test("a graduated coin refuses a quote without the creator's half", () => {
  assert.throws(() => assertGraduatedSolanaQuote({ feeBps: 100, creatorShareBps: 0 }), /paused/);
  assert.throws(() => assertGraduatedSolanaQuote({ feeBps: 0, creatorShareBps: 0 }), /paused/);
  assert.throws(() => assertGraduatedSolanaQuote({ feeBps: 50, creatorShareBps: 100 }), /paused/);
  const ok = { feeBps: 100, creatorShareBps: 50 };
  assert.equal(assertGraduatedSolanaQuote(ok), ok);
});

test("trade item: the coin's mint on chain 101, creator as owner", () => {
  const item = graduatedSolanaTradeItem({ campaign: "Camp", token: "Tok", creator: "Cre", name: "N", symbol: "S", logoURI: "u" }, "Mint");
  assert.deepEqual(item, { id: "campaign:101:Camp", chainId: 101, tokenAddress: "Mint", ownerWallet: "Cre", name: "N", symbol: "S", imageUrl: "u", status: "passed" });
});

test("the panel enforces it at submit, and the token page routes graduated Solana coins to it", () => {
  const panel = fs.readFileSync(new URL("../components/arena/ImportedTradePanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /if \(graduated && !solanaGraduatedImportRouteEnabled\(\)\) throw graduatedSolanaPausedError\(\);/);
  assert.match(panel, /graduated \? assertGraduatedSolanaQuote\(solanaQuote\) : solanaQuote/);
  const page = fs.readFileSync(new URL("../pages/TokenDetails.tsx", import.meta.url), "utf8");
  assert.match(page, /const solanaGraduatedImportTrade =\s*isSolanaPage &&\s*graduatedSolanaTradeRoute\(/);
  assert.match(page, /if \(solanaGraduatedImportTrade\) return;/);
  const warRoom = fs.readFileSync(new URL("../components/postgrad/WarRoomTradePanel.tsx", import.meta.url), "utf8");
  assert.match(warRoom, /if \(solanaGraduatedImport\) return;/);
  assert.match(warRoom, /if \(solanaGraduatedImport\) return <SolanaGraduatedImportPanel /);
});
