/**
 * Gen-7's own fees stack env (EVM_GEN7_ROUTER / _CREATOR_VAULT / _HOLDER_DISTRIBUTOR / _COMMUNITY_VAULT_<chainId>):
 * unset leaves every list exactly as before; set, the gen-7 router joins the RouteExecuted scan, the gen-7 vault
 * joins the creator-vault event scan and the creator-choice operator, with its own holder program.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { evmGen7FeesStack, withGen7Router, EVM_GEN7_HOLDER_PROGRAM } from "../evm/evmGen7Fees.js";
import { configuredGen5AuxContracts } from "../evm/evmGen5Aux.js";
import { DEFAULT_CHOICE_CONFIG } from "../evm/evmCreatorChoicePass.js";
import { operatedVaults, vaultAddress, vaultChoiceConfig } from "../evm/evmCreatorChoiceConfig.js";
import { DEFAULT_HOLDER_PROGRAM, buildLeafFile, checkLeafFile, holderBatchId } from "../evm/evmCreatorChoice.js";

const R7 = "0x1111111111111111111111111111111111111111";
const V7 = "0x2222222222222222222222222222222222222222";
const D7 = "0x3333333333333333333333333333333333333333";
const C7 = "0x4444444444444444444444444444444444444444";
const V6 = "0x6cb44e3db907801a04fa7a056fbe79799298af66";
const GEN6_ROUTERS = [
  { address: "0xe635aa43fe5707561c8c3c655225da5c3e4c2239", startBlock: 123629203 },
  { address: "0x8c8141b84cdb4634829cf1936f1e8cc14c61ceaa", startBlock: 125566831 },
];

test("unset: no gen-7 stack, router list and aux contracts unchanged, one operated vault (gen-6)", () => {
  const env = { EVM_CREATOR_VAULT_V2_56: `${V6}@125085249` } as any;
  const g = evmGen7FeesStack(56, env);
  assert.deepEqual(g, { router: null, creatorVault: null, holderDistributor: null, communityVault: null, invalid: [] });
  assert.equal(withGen7Router(56, GEN6_ROUTERS, env), GEN6_ROUTERS, "same array, untouched");
  assert.deepEqual(configuredGen5AuxContracts(56, env), [{ address: V6, startBlock: 125085249, kind: "creator_vault" }]);
  assert.deepEqual(operatedVaults(56, env), [{ vault: ethers.getAddress(V6), program: "airdrop_holders", label: "gen-6" }]);
  assert.equal(vaultAddress(56, env), ethers.getAddress(V6));
});

test("set: parsed per chain with start blocks; bad entries reported and ignored", () => {
  const env = {
    EVM_GEN7_ROUTER_56: `${R7}@130000000`,
    EVM_GEN7_CREATOR_VAULT_56: `${V7.toUpperCase().replace("0X", "0x")}@130000001`,
    EVM_GEN7_HOLDER_DISTRIBUTOR_56: D7,
    EVM_GEN7_COMMUNITY_VAULT_56: "not-an-address",
    EVM_GEN7_ROUTER_4663: "0x0000000000000000000000000000000000000000",
  } as any;
  const g = evmGen7FeesStack(56, env);
  assert.deepEqual(g.router, { address: ethers.getAddress(R7), startBlock: 130000000 });
  assert.deepEqual(g.creatorVault, { address: ethers.getAddress(V7), startBlock: 130000001 });
  assert.deepEqual(g.holderDistributor, { address: ethers.getAddress(D7), startBlock: 0 });
  assert.equal(g.communityVault, null);
  assert.deepEqual(g.invalid, ["EVM_GEN7_COMMUNITY_VAULT_56: not-an-address"]);
  assert.deepEqual(evmGen7FeesStack(4663, env).invalid, ["EVM_GEN7_ROUTER_4663: 0x0000000000000000000000000000000000000000"]);
  assert.equal(evmGen7FeesStack(97, env).router, null, "per chain");
  // A bad start block is refused, not read as 0.
  assert.deepEqual(evmGen7FeesStack(56, { EVM_GEN7_ROUTER_56: `${R7}@abc` } as any).invalid, [`EVM_GEN7_ROUTER_56: ${R7}@abc`]);
  void C7;
});

test("the gen-7 router joins the RouteExecuted scan once, lowercase, with its start block", () => {
  const env = { EVM_GEN7_ROUTER_56: `${ethers.getAddress(R7)}@130000000` } as any;
  const out = withGen7Router(56, GEN6_ROUTERS, env);
  assert.deepEqual(out, [...GEN6_ROUTERS, { address: R7, startBlock: 130000000 }]);
  assert.deepEqual(withGen7Router(56, out, env), out, "not twice");
  assert.equal(withGen7Router(4663, GEN6_ROUTERS, env), GEN6_ROUTERS, "other chains untouched");
});

test("the gen-7 vault joins the creator-vault event scan (its own cursor) and the operator, with its own program", () => {
  const env = { EVM_CREATOR_VAULT_V2_56: `${V6}@125085249`, EVM_GEN5_LP_LOCKERS_56: "0x5555555555555555555555555555555555555555@1", EVM_GEN7_CREATOR_VAULT_56: `${V7}@130000001` } as any;
  assert.deepEqual(configuredGen5AuxContracts(56, env), [
    { address: V6, startBlock: 125085249, kind: "creator_vault" },
    { address: "0x5555555555555555555555555555555555555555", startBlock: 1, kind: "lp_locker" },
    { address: V7, startBlock: 130000001, kind: "creator_vault" },
  ]);
  assert.deepEqual(operatedVaults(56, env), [
    { vault: ethers.getAddress(V6), program: "airdrop_holders", label: "gen-6" },
    { vault: ethers.getAddress(V7), program: EVM_GEN7_HOLDER_PROGRAM, label: "gen-7" },
  ]);
  // Gen-7 alone (no gen-6 vault on a fresh chain) still runs.
  assert.deepEqual(operatedVaults(97, { EVM_GEN7_CREATOR_VAULT_97: V7 } as any), [{ vault: ethers.getAddress(V7), program: EVM_GEN7_HOLDER_PROGRAM, label: "gen-7" }]);
  // The same address in both: operated once, as gen-6.
  assert.equal(operatedVaults(56, { EVM_CREATOR_VAULT_V2_56: V6, EVM_GEN7_CREATOR_VAULT_56: V6 } as any).length, 1);
});

test("per-vault holder batch ceiling: gen-6 keeps the chain value, gen-7 has its own (falls back to the chain value)", () => {
  const base = { ...DEFAULT_CHOICE_CONFIG, masterSecret: "x", holderBatchMaxWei: 5n };
  const g6 = { vault: V6, program: DEFAULT_HOLDER_PROGRAM, label: "gen-6" as const };
  const g7 = { vault: V7, program: EVM_GEN7_HOLDER_PROGRAM, label: "gen-7" as const };
  assert.equal(vaultChoiceConfig(base, 56, g6, { EVM_GEN7_HOLDER_BATCH_MAX_WEI_56: "9" } as any), base);
  assert.equal(vaultChoiceConfig(base, 56, g7, { EVM_GEN7_HOLDER_BATCH_MAX_WEI_56: "9" } as any).holderBatchMaxWei, 9n);
  assert.equal(vaultChoiceConfig(base, 56, g7, { EVM_GEN7_HOLDER_BATCH_MAX_WEI: "8" } as any).holderBatchMaxWei, 8n);
  assert.equal(vaultChoiceConfig(base, 56, g7, {} as any).holderBatchMaxWei, 5n);
});

test("holder batch ids: gen-6 unchanged, gen-7 by its program; the leaf file names a non-default program and checks it", () => {
  assert.equal(holderBatchId(56, "2026-09-28"), ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-09-28:airdrop_holders")));
  assert.equal(holderBatchId(56, "2026-09-28", EVM_GEN7_HOLDER_PROGRAM), ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-09-28:airdrop_holders_gen7")));
  assert.throws(() => holderBatchId(56, "2026-09-28", "bad:program"), /bad holder program/);
  const perCoin = new Map([["0x00000000000000000000000000000000000007c1", new Map([["0x00000000000000000000000000000000000000f1", 10n ** 18n]])]]);
  const common = {
    chainId: 56, vault: V7, holderDistributor: D7, weekId: "2026-09-28", claimDeadline: 1, weekCommitment: "c", perCoin, minPayout: 1n,
    snapshots: [{ campaign: "0x00000000000000000000000000000000000007c1", token: "0x00000000000000000000000000000000000017c1", block: 1, holders: 1, pot: 10n ** 18n }],
  };
  const g7 = buildLeafFile({ ...common, program: EVM_GEN7_HOLDER_PROGRAM })!;
  assert.equal(g7.program, EVM_GEN7_HOLDER_PROGRAM);
  assert.equal(g7.batchId, holderBatchId(56, "2026-09-28", EVM_GEN7_HOLDER_PROGRAM));
  checkLeafFile(g7);
  const g6 = buildLeafFile(common)!;
  assert.equal("program" in g6, false, "gen-6 files keep their shape");
  checkLeafFile(g6);
  // A gen-7 file stripped of its program no longer matches its batch id.
  const { program: _p, ...stripped } = g7;
  assert.throws(() => checkLeafFile(stripped as any), /batch id/);
});

test("the Safe signers' verify script accepts a gen-7 leaf file and picks the gen-7 vault variable", async () => {
  const verify = await import("../../../scripts/evm-holder-batch-verify.mjs" as string);
  const perCoin = new Map([["0x00000000000000000000000000000000000007c1", new Map([["0x00000000000000000000000000000000000000f1", 3n], ["0x00000000000000000000000000000000000000f2", 1n]])]]);
  const file = buildLeafFile({
    chainId: 4663, vault: V7, holderDistributor: D7, weekId: "2026-09-28", claimDeadline: 1, weekCommitment: "c", perCoin, minPayout: 1n,
    snapshots: [{ campaign: "0x00000000000000000000000000000000000007c1", token: "0x00000000000000000000000000000000000017c1", block: 1, holders: 2, pot: 4n }],
    program: EVM_GEN7_HOLDER_PROGRAM,
  })!;
  const { total } = verify.checkLeafFile(file);
  assert.equal(BigInt(total), 4n);
  assert.equal(verify.holderBatchId(4663, "2026-09-28", EVM_GEN7_HOLDER_PROGRAM), file.batchId);
  assert.equal(verify.vaultEnvName(4663, EVM_GEN7_HOLDER_PROGRAM), "EVM_GEN7_CREATOR_VAULT_4663");
  assert.equal(verify.vaultEnvName(4663), "EVM_CREATOR_VAULT_V2_4663");
  assert.throws(() => verify.checkLeafFile({ ...file, program: undefined }), /batch id/);
});
