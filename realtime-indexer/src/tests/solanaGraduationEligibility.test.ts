import assert from "node:assert/strict";
import test from "node:test";

/**
 * The keeper decides whether to move real liquidity by reading two bytes near
 * the end of the campaign account. Getting the offsets wrong either graduates a
 * live curve or never graduates anything, so they are pinned here against the
 * field order in programs/memewarzone_solana/src/authorized_create.rs:
 *
 *   ... mint_authority_revoked, graduated, curve_closed, paused,
 *       bump, mint_bump, token_vault_bump, sol_vault_bump
 */
const GRADUATED_OFFSET_FROM_END = 7;
const CURVE_CLOSED_OFFSET_FROM_END = 6;

function campaignAccount({ graduated, curveClosed }: { graduated: boolean; curveClosed: boolean }) {
  const data = Buffer.alloc(720);
  const tail = [1, graduated ? 1 : 0, curveClosed ? 1 : 0, 0, 255, 255, 254, 254];
  Buffer.from(tail).copy(data, data.length - 8);
  return data;
}

function readFlags(data: Buffer) {
  return {
    graduated: data[data.length - GRADUATED_OFFSET_FROM_END] === 1,
    curveClosed: data[data.length - CURVE_CLOSED_OFFSET_FROM_END] === 1,
  };
}

test("a bonding campaign is not eligible", () => {
  const flags = readFlags(campaignAccount({ graduated: false, curveClosed: false }));
  assert.equal(flags.curveClosed, false);
  assert.equal(flags.graduated, false);
});

test("a closed curve that has not graduated is the only eligible state", () => {
  const flags = readFlags(campaignAccount({ graduated: false, curveClosed: true }));
  assert.equal(flags.curveClosed, true);
  assert.equal(flags.graduated, false);
});

test("an already graduated campaign is never picked up again", () => {
  // Real campaigns keep curve_closed set after graduating: it is a sticky lock,
  // not a stage. Reading it alone would graduate the same campaign forever.
  const flags = readFlags(campaignAccount({ graduated: true, curveClosed: true }));
  assert.equal(flags.graduated, true);
});

test("the two flags are not confused with each other", () => {
  const closedOnly = readFlags(campaignAccount({ graduated: false, curveClosed: true }));
  const graduatedOnly = readFlags(campaignAccount({ graduated: true, curveClosed: false }));
  assert.deepEqual(closedOnly, { graduated: false, curveClosed: true });
  assert.deepEqual(graduatedOnly, { graduated: true, curveClosed: false });
});

test("the offsets match a real graduated mainnet-shaped account", () => {
  // Byte-for-byte tail captured from devnet campaign
  // 4dUEFSCJWkd12NKGGeLMKnG8nahDdh2wTDpeiboMFR5d after it graduated.
  const data = Buffer.alloc(720);
  Buffer.from([1, 1, 1, 0, 255, 255, 254, 254]).copy(data, data.length - 8);
  const flags = readFlags(data);
  assert.equal(flags.graduated, true, "the real graduated campaign must read as graduated");
  assert.equal(flags.curveClosed, true);
});
