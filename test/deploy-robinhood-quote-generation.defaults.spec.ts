import { expect } from "chai";
import { ethers } from "hardhat";
import { resolveRouteAuthorityAndOwner, TESTNET_ROUTE_AUTHORITY } from "../scripts/deploy-robinhood-quote-generation";

// Audit 5: the Robinhood generation script must not fall back to the testnet route authority or to a
// deployer-owned generation on mainnet (4663).
describe("deploy-robinhood-quote-generation: mainnet refuses testnet defaults", function () {
  const deployer = ethers.getAddress("0x77f96a7d00000000000000000000000000000001");
  const safe = ethers.getAddress("0x1edcedf500000000000000000000000000000002");
  const prod = ethers.getAddress("0xb989a99800000000000000000000000000000003");
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { a: process.env.RH_ROUTE_AUTHORITY, o: process.env.RH_OWNER };
    delete process.env.RH_ROUTE_AUTHORITY;
    delete process.env.RH_OWNER;
  });
  afterEach(() => {
    for (const [k, v] of [["RH_ROUTE_AUTHORITY", saved.a], ["RH_OWNER", saved.o]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("testnet keeps its defaults", () => {
    const r = resolveRouteAuthorityAndOwner(46630n, deployer);
    expect(r.routeAuthority).to.eq(ethers.getAddress(TESTNET_ROUTE_AUTHORITY));
    expect(r.owner).to.eq(deployer);
  });

  it("mainnet without RH_ROUTE_AUTHORITY stops", () => {
    process.env.RH_OWNER = safe;
    expect(() => resolveRouteAuthorityAndOwner(4663n, deployer)).to.throw("RH_ROUTE_AUTHORITY is required");
  });

  it("mainnet with the testnet authority stops", () => {
    process.env.RH_ROUTE_AUTHORITY = TESTNET_ROUTE_AUTHORITY.toLowerCase();
    process.env.RH_OWNER = safe;
    expect(() => resolveRouteAuthorityAndOwner(4663n, deployer)).to.throw("testnet authority");
  });

  it("mainnet without RH_OWNER stops, and the deployer as owner stops", () => {
    process.env.RH_ROUTE_AUTHORITY = prod;
    expect(() => resolveRouteAuthorityAndOwner(4663n, deployer)).to.throw("RH_OWNER is required");
    process.env.RH_OWNER = deployer.toLowerCase();
    expect(() => resolveRouteAuthorityAndOwner(4663n, deployer)).to.throw("must not be the deployer");
  });

  it("mainnet with explicit production values passes", () => {
    process.env.RH_ROUTE_AUTHORITY = prod;
    process.env.RH_OWNER = safe;
    expect(resolveRouteAuthorityAndOwner(4663n, deployer)).to.deep.eq({ routeAuthority: prod, owner: safe });
  });
});
