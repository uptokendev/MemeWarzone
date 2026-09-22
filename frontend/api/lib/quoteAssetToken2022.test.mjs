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
