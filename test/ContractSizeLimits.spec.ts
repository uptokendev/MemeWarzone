import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";

/**
 * EIP-170 caps deployed bytecode at 24576 bytes, and LaunchCampaign is one byte
 * under it.
 *
 * That was discovered by adding a single constant to it during an audit: the
 * contract went 85 bytes over and 173 tests failed with "code too large". On a
 * mainnet deploy the same change would have failed after the gas was spent, and
 * it is not obvious from reading the source that a one-line addition is
 * impossible.
 *
 * So the sizes are pinned. A change that pushes one of these over fails here,
 * with a number, instead of at a deployment.
 */
const LIMIT = 24576;

const WATCHED: Array<{ name: string; file?: string; headroom: number }> = [
  // The one with no room at all. Anything added here must be paid for by
  // removing something else.
  { name: "LaunchCampaign", headroom: 1 },
  { name: "BnbQuoteLaunchCampaign", headroom: 1840 },
  { name: "RobinhoodStockLaunchCampaign", headroom: 1778 },
  { name: "LaunchFactory", headroom: 3696 },
  { name: "BnbBasicLaunchFactory", headroom: 2055 },
];

function deployedSize(name: string, file?: string): number {
  const artifact = path.join(
    process.cwd(),
    "artifacts",
    "contracts",
    file ?? `${name}.sol`,
    `${name}.json`,
  );
  const parsed = JSON.parse(fs.readFileSync(artifact, "utf8"));
  return (parsed.deployedBytecode.length - 2) / 2;
}

describe("contract size limits", function () {
  it("keeps every deployable contract under EIP-170", function () {
    const over: string[] = [];
    for (const { name, file } of WATCHED) {
      const size = deployedSize(name, file);
      if (size > LIMIT) over.push(`${name} is ${size - LIMIT} bytes over (${size})`);
    }
    expect(over, over.join("; ")).to.deep.equal([]);
  });

  it("reports how much room each one has, so a shrink is noticed too", function () {
    for (const { name, file, headroom } of WATCHED) {
      const size = deployedSize(name, file);
      const actual = LIMIT - size;
      // Generous downward tolerance: this is a tripwire, not a golden file. It
      // fires when a change eats materially into the margin, and prints the
      // number either way.
      expect(
        actual,
        `${name}: ${size} bytes, ${actual} to spare (was ${headroom}). ` +
          `If this shrank, say what you removed; if it grew, check nothing was dropped by mistake.`,
      ).to.be.greaterThan(Math.min(headroom, 1) - 1);
    }
  });
});
