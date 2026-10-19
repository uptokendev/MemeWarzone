/**
 * A fill from the gen-8 trade panel posts the token to the indexer. The client itself does not:
 * the fork tests must not hit the network.
 *   node --test src/lib/gen8TradeWake.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("a gen-8 fill in the app wakes the indexer with the token address", () => {
  const panel = fs.readFileSync(path.join(here, "../components/evm/Gen8TradePanel.tsx"), "utf8");
  assert.match(panel, /import \{ notifyIndexerFills \} from "@\/lib\/indexerTradeIngest"/);
  assert.match(panel, /if \(txHash\) notifyIndexerFills\(\{ chainId, campaignAddress: token, txHashes: \[txHash\] \}\)/);
  const notifyAt = panel.indexOf("notifyIndexerFills({ chainId, campaignAddress: token, txHashes: [txHash] })");
  const toastAt = panel.indexOf("toast.success");
  assert.ok(notifyAt > 0 && notifyAt < toastAt, "the wake is posted before the confirmation toast");
  assert.match(panel, /memewarzone:txConfirmed/);
  const client = fs.readFileSync(path.join(here, "evmGen8Client.mjs"), "utf8");
  assert.equal(client.includes("notifyIndexerFills"), false);
  const receiptAt = client.indexOf("if (onReceipt) onReceipt(receipt);");
  const tradeReturn = client.indexOf("return { receipt, quote: q, call };");
  assert.ok(receiptAt > 0 && receiptAt < tradeReturn, "the swap receipt callback runs before the trade returns");
  const ingest = fs.readFileSync(path.join(here, "indexerTradeIngest.ts"), "utf8");
  assert.match(ingest, /\[56, 97, 4663, 46630\]/);
});
