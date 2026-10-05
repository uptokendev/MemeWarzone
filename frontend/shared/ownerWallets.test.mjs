// The one owner / internal wallet list (founder, 2026-10-05: "Exclude all owner wallets from leagues
// and recruiters"). Pins its format, the env extension and the indexer copy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import {
  OWNER_WALLETS,
  internalRecruiterLabel,
  isOwnerWallet,
  ownerWalletIndex,
  ownerWalletLabel,
  withoutOwnerWallets,
} from "./ownerWallets.mjs";
import { INTERNAL_WALLETS, internalWalletIndex } from "../api/lib/moderationInternalWallets.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const BNB_DEPLOYER = "0x1A367016f10b230E28Cf1ABda2594C47bf60fe34";

test("every entry is a valid key: Solana base58 in its exact case, EVM lowercased; no duplicates; a label each", () => {
  for (const row of OWNER_WALLETS) {
    assert.ok(row.label && row.label.length > 3, `${row.address} has a label`);
    if (row.chain === "solana") {
      assert.equal(new PublicKey(row.address).toBase58(), row.address, `${row.address} is canonical base58`);
    } else {
      assert.equal(row.chain, "evm");
      assert.ok(ethers.isAddress(row.address), row.address);
      assert.equal(row.address, row.address.toLowerCase(), `${row.address} is lowercased`);
    }
  }
  assert.equal(new Set(OWNER_WALLETS.map((w) => w.address.toLowerCase())).size, OWNER_WALLETS.length, "no duplicates");
});

test("the wallets seen winning on 2026-10-05 are on the list", () => {
  for (const address of [
    DEPLOYER,
    BNB_DEPLOYER,
    "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB",
    "4AjT4LkVuf9mrgoPN4KisZnKKQwiPw7JbMUJckBEhy8j",
    "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9",
    "8rEczXrZZMzpp3MAUbs8TWftaZcJxctydwnkHLsdWaRv",
  ]) assert.ok(isOwnerWallet(address, ownerWalletIndex({})), address);
});

test("matching ignores case (recruiters.wallet_address stores Solana keys lowercased) and blanks are never owners", () => {
  const index = ownerWalletIndex({});
  assert.ok(isOwnerWallet(DEPLOYER.toLowerCase(), index));
  assert.ok(isOwnerWallet(BNB_DEPLOYER, index));
  assert.ok(isOwnerWallet(BNB_DEPLOYER.toLowerCase(), index));
  assert.equal(isOwnerWallet("", index), false);
  assert.equal(isOwnerWallet(null, index), false);
  assert.equal(isOwnerWallet("CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf", index), false);
});

test("OWNER_WALLETS and MODERATION_INTERNAL_WALLETS extend the list, with optional labels", () => {
  const index = ownerWalletIndex({
    OWNER_WALLETS: "So1anaTestWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXX:Founder test, 0xF00000000000000000000000000000000000BEEF",
    MODERATION_INTERNAL_WALLETS: "0xABC0000000000000000000000000000000000001:Ops test",
  });
  assert.equal(ownerWalletLabel("So1anaTestWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXX", index), "Founder test");
  assert.equal(index.get("so1anatestwa11etxxxxxxxxxxxxxxxxxxxxxxxxxxx").address, "So1anaTestWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXX", "Solana case kept");
  assert.equal(index.get("0xf00000000000000000000000000000000000beef").address, "0xf00000000000000000000000000000000000beef", "EVM lowercased");
  assert.equal(ownerWalletLabel("0xabc0000000000000000000000000000000000001", index), "Ops test");
  assert.equal(index.size, OWNER_WALLETS.length + 3);
});

test("withoutOwnerWallets keeps order, so the next row takes the freed place", () => {
  const rows = [{ w: DEPLOYER }, { w: "A1" }, { w: BNB_DEPLOYER.toLowerCase() }, { w: "B2" }];
  assert.deepEqual(withoutOwnerWallets(rows, (r) => r.w, ownerWalletIndex({})).map((r) => r.w), ["A1", "B2"]);
});

test("a recruiter is internal when its signup wallet (any chain) or a payout wallet is ours", () => {
  const index = ownerWalletIndex({});
  assert.ok(internalRecruiterLabel({ walletAddress: "hukfofuuwxc5qfzxzr5dbax4s7w4vjuw8ahv9ld4c2j9" }, index), "lowercased stored Solana key");
  assert.ok(internalRecruiterLabel({ walletAddress: "0x1", signup: { solanaWalletAddress: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB" } }, index));
  assert.ok(internalRecruiterLabel({ walletAddress: "0x1", payoutWallets: ["0x1A367016f10b230E28Cf1ABda2594C47bf60fe34"] }, index));
  assert.equal(internalRecruiterLabel({ walletAddress: "CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf", payoutWallets: [] }, index), null);
});

test("the moderation list is the same list", () => {
  assert.equal(INTERNAL_WALLETS, OWNER_WALLETS);
  assert.deepEqual([...internalWalletIndex({}).keys()], [...ownerWalletIndex({}).keys()]);
});

test("the indexer copy (realtime-indexer/src/rewards/ownerWallets.ts) has the same addresses, chains and labels", () => {
  const ts = fs.readFileSync(path.join(repo, "realtime-indexer/src/rewards/ownerWallets.ts"), "utf8");
  const entries = [...ts.matchAll(/\{ address: "([^"]+)", chain: "(solana|evm)", label: "([^"]+)" \}/g)].map((m) => ({ address: m[1], chain: m[2], label: m[3] }));
  assert.deepEqual(entries, OWNER_WALLETS.map(({ address, chain, label }) => ({ address, chain, label })));
});
