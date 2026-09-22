import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/test";

const { token2022MintExtensions, disallowedToken2022Extensions } = await import("./quoteAssetVerification.js");

/** A Token-2022 mint: 82-byte base, account type at 165, then TLV entries. */
function mintWithExtensions(entries) {
  const tlv = [];
  for (const [type, length] of entries) {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(length, 2);
    tlv.push(head, Buffer.alloc(length));
  }
  return Buffer.concat([Buffer.alloc(165), Buffer.from([1]), ...tlv]);
}

test("a classic-sized mint has no extensions", () => {
  assert.deepEqual(token2022MintExtensions(Buffer.alloc(82)), []);
  assert.deepEqual(token2022MintExtensions(Buffer.alloc(165)), []);
});

test("extension types are read out of the TLV in order", () => {
  // MetadataPointer(18) then TokenMetadata(19).
  assert.deepEqual(token2022MintExtensions(mintWithExtensions([[18, 64], [19, 32]])), [18, 19]);
});

test("metadata and grouping extensions are accepted", () => {
  for (const type of [18, 19, 20, 21, 22, 23]) {
    assert.deepEqual(disallowedToken2022Extensions(mintWithExtensions([[type, 8]])), []);
  }
});

test("anything that can move or hide a balance is refused by name", () => {
  // The same set graduation refuses; naming them tells the operator why.
  const cases = {
    1: "TransferFeeConfig", 12: "PermanentDelegate", 14: "TransferHook",
    4: "ConfidentialTransferMint", 9: "NonTransferable", 6: "DefaultAccountState",
    3: "MintCloseAuthority", 10: "InterestBearingConfig",
  };
  for (const [type, name] of Object.entries(cases)) {
    assert.deepEqual(disallowedToken2022Extensions(mintWithExtensions([[Number(type), 16]])), [name]);
  }
});

test("an unknown future extension is refused rather than waved through", () => {
  assert.deepEqual(disallowedToken2022Extensions(mintWithExtensions([[999, 8]])), ["Unknown(999)"]);
});

test("one bad extension among good ones still refuses, and only names the bad", () => {
  const data = mintWithExtensions([[18, 64], [1, 108], [19, 32]]);
  assert.deepEqual(disallowedToken2022Extensions(data), ["TransferFeeConfig"]);
});

test("the xStocks carry six extensions the allowlist refuses", () => {
  // Observed 2026-09-22 on the real mainnet mints named in the catalog
  // (NVDAx, AAPLx, COINx, METAx all carry the identical set):
  //   18 MetadataPointer, 12 PermanentDelegate, 6 DefaultAccountState,
  //   25 ScaledUiAmount, 26 Pausable, 4 ConfidentialTransferMint,
  //   14 TransferHook, 19 TokenMetadata
  //
  // This is a regulated-RWA profile, and every refused member is refused for a
  // reason that applies directly to a permanently-locked LP: a permanent
  // delegate can move the pool's quote out, a default-frozen account state can
  // freeze the recovery account, a transfer hook runs third-party code inside
  // the sweep, and a pausable mint can halt a graduation mid-flight.
  //
  // 25 and 26 also postdate the pinned spl-token-2022 3.0.5, so the program
  // cannot parse them either and refuses the mint on its own.
  const xStock = [
    [18, 64], [12, 32], [6, 1], [25, 16], [26, 1], [4, 97], [14, 64], [19, 128],
  ];
  const data = Buffer.concat([
    Buffer.alloc(165), Buffer.from([1]),
    ...xStock.flatMap(([type, length]) => {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(type, 0);
      head.writeUInt16LE(length, 2);
      return [head, Buffer.alloc(length)];
    }),
  ]);
  const disallowed = disallowedToken2022Extensions(data);
  assert.deepEqual(disallowed, [
    "PermanentDelegate", "DefaultAccountState", "Unknown(25)", "Unknown(26)",
    "ConfidentialTransferMint", "TransferHook",
  ]);
  // Accepting xStocks as quote assets is a deliberate risk decision, not an
  // oversight. If that decision is taken, this test is the place it changes.
});
