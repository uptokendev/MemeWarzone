import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
const PFEAGLE_MIXED = "0x1a95c10E4839033686225eaad3ac348F0d8eDC4F";
const PFEAGLE = PFEAGLE_MIXED.toLowerCase();
const { default: searchAddress, mapAddressMatches, parseSearchAddress, SEARCH_ADDRESS_SQL } = await import("./searchAddress.js");

test("address parsing: EVM lowercased, Solana kept exact, anything else refused", () => {
  assert.deepEqual(parseSearchAddress(` ${PFEAGLE_MIXED} `), { address: PFEAGLE, evm: true });
  assert.deepEqual(parseSearchAddress("6VJnmXSHkC7aSrDWbMt7AvPLZPBGfq2iSZbM6nC1bonk"), { address: "6VJnmXSHkC7aSrDWbMt7AvPLZPBGfq2iSZbM6nC1bonk", evm: false });
  assert.equal(parseSearchAddress("pepe"), null);
  assert.equal(parseSearchAddress("0x1234"), null);
});

test("SQL: every chain, case rule per chain family, hidden test coins out, imports whatever their Arena status", () => {
  assert.doesNotMatch(SEARCH_ADDRESS_SQL.campaigns, /chain_id = \$/);
  assert.match(SEARCH_ADDRESS_SQL.campaigns, /lower\(c\.token_address\) = \$1 or lower\(c\.campaign_address\) = \$1\) and c\.chain_id not in \(101, 102\)/);
  assert.match(SEARCH_ADDRESS_SQL.campaigns, /\(c\.token_address = \$1 or c\.campaign_address = \$1\) and c\.chain_id in \(101, 102\)/);
  assert.match(SEARCH_ADDRESS_SQL.campaigns, /and not \(lower\(coalesce\(c\.meta->>'publicHidden', 'false'\)\) in \('true', '1', 'yes', 'on'\)\)/);
  assert.doesNotMatch(SEARCH_ADDRESS_SQL.imports, /status = 'passed'\s+(and|limit)/);
});

test("matches: our coin wins over an import row of the same token; imports link as imports", () => {
  const items = mapAddressMatches({
    campaigns: [{ chain_id: 56, campaign_address: "0xc", token_address: "0xt", name: "Ours", symbol: "OUR", logo_uri: null, graduated_at_chain: null }],
    imports: [
      { chain_id: 56, token_address: "0xT", name: "Dup", symbol: "$DUP", image_url: null, status: "passed" },
      { chain_id: 4663, token_address: "0x1a95", name: "PFEAGLE", symbol: "$PFEAGLE", image_url: "i", status: "declined" },
    ],
  });
  assert.deepEqual(items.map((i) => [i.kind, i.chainId, i.symbol]), [["campaign", 56, "OUR"], ["import", 4663, "PFEAGLE"]]);
});

test("handler: 400 on a non-address, rows on a hit", async () => {
  const res = () => {
    const r = { statusCode: 0, body: null, headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = (b) => { r.body = typeof b === "string" ? JSON.parse(b) : b; return r; };
    r.writeHead = (c) => { r.statusCode = c; return r; };
    return r;
  };
  const bad = res();
  await searchAddress({ method: "GET", url: "/api/search/address?address=pepe" }, bad, { query: async () => ({ rows: [] }) });
  assert.equal(bad.statusCode, 400);
  const db = { query: async (sql) => ({ rows: sql.includes("arena_token_imports") ? [{ chain_id: 4663, token_address: PFEAGLE, name: "PFEAGLE", symbol: "$PFEAGLE", image_url: null, status: "declined" }] : [] }) };
  const ok = res();
  await searchAddress({ method: "GET", url: `/api/search/address?address=${PFEAGLE_MIXED}` }, ok, db);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.items[0].chainId, 4663);
});

test("client: searches every chain, puts an exact address match first, no Wallet row for a coin address", () => {
  const src = fs.readFileSync(new URL("../src/lib/searchClient.ts", import.meta.url), "utf8");
  assert.match(src, /const chainIds = opts\?\.chainOnly \? getBnbCampaignFeedChainIds\(opts\?\.chainId\) : searchChainIds\(\);/);
  assert.match(src, /\[SOLANA_CHAIN_ID, BNB_CHAIN_ID, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID\]\.flatMap\(\(id\) => getBnbCampaignFeedChainIds\(id\)\)/);
  assert.match(src, /apiFetch\(`\/api\/search\/address\?address=\$\{encodeURIComponent\(raw\)\}`/);
  assert.match(src, /score: exact\.has\(key\(row\)\) \? 2000 : scoreRow\(query, row\)/);
  assert.match(src, /const wallet = addressMatches\.length \? null : walletResult\(query, profileChain\);/);
  const popup = fs.readFileSync(new URL("../src/components/search/SearchPopup.tsx", import.meta.url), "utf8");
  assert.match(popup, /chainOnly: Boolean\(onSelectToken\)/, "the battle coin picker stays on its chain");
  const server = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /router\.all\("\/search\/address", wrap\(searchAddress\)\);/);
});
