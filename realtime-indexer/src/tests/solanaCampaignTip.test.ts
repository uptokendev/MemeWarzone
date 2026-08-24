import assert from "node:assert/strict";
import test from "node:test";
import { selectUnknownPdaTipSignatures } from "../solanaIndexerCheckpoint.js";

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
