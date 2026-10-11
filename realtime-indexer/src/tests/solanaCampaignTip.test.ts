import assert from "node:assert/strict";
import test from "node:test";
import { selectUnknownPdaTipSignatures, tipKnownSignatures } from "../solanaIndexerCheckpoint.js";

const FIRST = "heWs9aJGiKrEgDhQ1pLhabmV7pehtTiz7pP3ZqopaEVxYTCVtpEGpd1pFvr56bjxXCuMBnvocznKwexR4DJqHqP";
const SECOND = "3oZaXc5EAodXDH6qaZK9Pftds1DjVD8vkizRFU6zJppA272F5hk7xfpZcGpULbZXMySC26C3WdE4tFXiQ939BtXz";

test("history-complete book still selects a later ALMOST buy signature", () => {
  const unknown = selectUnknownPdaTipSignatures({
    signatures: [
      { signature: SECOND, slot: 441256954, err: null },
      { signature: FIRST, slot: 441223620, err: null },
    ],
    known: [FIRST],
    limit: 15,
  });
  assert.deepEqual(unknown.map((item) => item.signature), [SECOND]);
});

test("failed signatures are not selected for tip ingest", () => {
  const unknown = selectUnknownPdaTipSignatures({
    signatures: [{ signature: SECOND, slot: 441256954, err: { InstructionError: [] } }],
    known: [],
  });
  assert.equal(unknown.length, 0);
});

test("already-indexed signatures are not fetched again", () => {
  const unknown = selectUnknownPdaTipSignatures({
    signatures: [
      { signature: FIRST, slot: 441223620, err: null },
      { signature: SECOND, slot: 441256954, err: null },
    ],
    known: [FIRST, SECOND],
  });
  assert.equal(unknown.length, 0);
});

test("tip known set: trades always known; scanned signatures only after the grace window", () => {
  const now = 10_000_000;
  const known = tipKnownSignatures({
    tradeSignatures: [FIRST],
    scanned: [
      { signature: SECOND, markedAtMs: now - 60_000 },
      { signature: "old", markedAtMs: now - 600_001 },
      { signature: "edge", markedAtMs: now - 600_000 },
      { signature: "fresh", markedAtMs: now - 599_999 },
    ],
    nowMs: now,
    graceMs: 600_000,
  });
  assert.deepEqual([...known].sort(), [FIRST, "edge", "old"].sort());
  assert.equal(known.has("fresh"), false, "1 ms inside the grace: still retried");
  assert.equal(known.has(SECOND), false, "marked a minute ago: still retried");
});

test("tip known set: a recently scanned non-trade signature is selected again, an old one is not", () => {
  const now = 10_000_000;
  const signatures = [
    { signature: FIRST, slot: 1, err: null },
    { signature: SECOND, slot: 2, err: null },
  ];
  const recent = tipKnownSignatures({ tradeSignatures: [], scanned: [{ signature: SECOND, markedAtMs: now - 1_000 }, { signature: FIRST, markedAtMs: now - 1_000 }], nowMs: now, graceMs: 600_000 });
  assert.equal(selectUnknownPdaTipSignatures({ signatures, known: recent }).length, 2);
  const aged = tipKnownSignatures({ tradeSignatures: [], scanned: [{ signature: SECOND, markedAtMs: now - 700_000 }, { signature: FIRST, markedAtMs: now - 700_000 }], nowMs: now, graceMs: 600_000 });
  assert.equal(selectUnknownPdaTipSignatures({ signatures, known: aged }).length, 0);
});

test("tip known set: grace 0 treats every scanned signature as known; bad rows are ignored", () => {
  const known = tipKnownSignatures({
    tradeSignatures: [""],
    scanned: [{ signature: FIRST, markedAtMs: 5 }, { signature: SECOND, markedAtMs: Number.NaN }, { signature: "", markedAtMs: 1 }],
    nowMs: 5,
    graceMs: 0,
  });
  assert.deepEqual([...known], [FIRST]);
});
