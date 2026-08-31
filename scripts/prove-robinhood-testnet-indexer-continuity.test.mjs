import assert from "node:assert/strict";
import test from "node:test";
import { proveRobinhoodIndexerContinuity } from "./prove-robinhood-testnet-indexer-continuity.mjs";

const CAMPAIGN = "0x00000000000000000000000000000000000000aa";

test("continuity requires a 46630 campaign row and rejects a 56 alias", () => {
  assert.equal(
    proveRobinhoodIndexerContinuity({
      rows: [{ chain_id: 46630, campaign_address: CAMPAIGN }],
      campaignAddress: CAMPAIGN,
    }),
    true,
  );
  assert.throws(
    () => proveRobinhoodIndexerContinuity({ rows: [{ chain_id: 56, campaign_address: CAMPAIGN }], campaignAddress: CAMPAIGN }),
    /never alias to BNB/,
  );
  assert.throws(
    () => proveRobinhoodIndexerContinuity({ rows: [], campaignAddress: CAMPAIGN }),
    /not recorded as chain 46630/,
  );
});
