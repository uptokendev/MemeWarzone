import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const { EVENT_FRAGMENTS } = require("../scripts/lib/indexerManifest.cjs");

/**
 * The launch-generation contracts' manifest events must be exactly the compiled ABI's events (indexed
 * flags included): an event the contract no longer emits (TreasuryRouterV4's CreatorRewardsVaultProposed,
 * removed in fix round B) or a new one the manifest misses (CreatorRewardsVaultV2's HolderBatchApproved)
 * fails here instead of silently never matching a log.
 */
const CONTRACTS: Record<string, string> = {
  TreasuryRouterV4: "contracts/TreasuryRouterV4.sol/TreasuryRouterV4.json",
  CreatorRewardsVaultV2: "contracts/CreatorRewardsVaultV2.sol/CreatorRewardsVaultV2.json",
};

function full(fragment: ethers.EventFragment): string {
  return fragment.format("full");
}

describe("indexer manifest: launch-generation events equal the compiled contracts", () => {
  for (const [name, artifactPath] of Object.entries(CONTRACTS)) {
    it(name, () => {
      const artifact = JSON.parse(readFileSync(path.join(process.cwd(), "artifacts", artifactPath), "utf8"));
      const compiled = new ethers.Interface(artifact.abi);
      const fromArtifact: string[] = [];
      compiled.forEachEvent((event) => fromArtifact.push(full(event)));
      const fromManifest = (EVENT_FRAGMENTS[name] as string[]).map((f) => full(ethers.EventFragment.from(`event ${f}`)));
      expect([...fromManifest].sort()).to.deep.equal([...fromArtifact].sort());
    });
  }

  it("CreatorRewardsVaultProposed is gone from TreasuryRouterV4; HolderBatchApproved is indexed", () => {
    expect((EVENT_FRAGMENTS.TreasuryRouterV4 as string[]).some((f) => f.startsWith("CreatorRewardsVaultProposed("))).to.eq(false);
    expect((EVENT_FRAGMENTS.CreatorRewardsVaultV2 as string[]).some((f) => f.startsWith("HolderBatchApproved("))).to.eq(true);
  });
});
