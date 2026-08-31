import { ethers } from "hardhat";

export const LIVE_97_FACTORY = "0x77Af7634837643d4f93d1086b492571268b30B5F";
export const LIVE_97_LOCKER = "0xb083929D2bbabdE7fc580090D5B18bbD918Fda9a";
export const LIVE_97_TREASURY_V2 = "0x0b0b3412bebaf92ABf1b3c977ee1664344e2d35d";
export const LIVE_97_ADAPTER = "0xC49895Ee36Ad19aa5Cb1405761f6272aD7be6357";
export const LIVE_97_ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
export const LIVE_97_CAMPAIGN_IMPL = "0x43A65f33F29cB1A2558255064D1F8C55D2C45827";
export const LIVE_56_FACTORY = "0xc378221E57898106079aE4B818a92978e4cd9559";
export const LIVE_TOPAZ_ROUTER = "0xe559d93643631E9E8Cc7d10ADFA581Be4b5399C8";
export const LIVE_TOPAZ_FACTORY = "0xE34346710cca352a3b69A080067d176C8ACA97D9";

export const PROTECTED_LIVE_ADDRESSES = [
  LIVE_97_FACTORY,
  LIVE_97_LOCKER,
  LIVE_97_TREASURY_V2,
  LIVE_97_ADAPTER,
  LIVE_97_CAMPAIGN_IMPL,
  LIVE_56_FACTORY,
];

export type LiveFactorySnapshot = {
  address: string;
  codeHash: string;
  exists: boolean;
  factoryGeneration: string | null;
  campaignGeneration: string | null;
  live: boolean | null;
  createPaused: boolean | null;
  routeAuthority: string | null;
  owner: string | null;
  campaignsCount: string | null;
  feeRecipient: string | null;
  router: string | null;
  permanentLpLocker: string | null;
  liquidityKind: string | null;
  protocolFeeBps: string | null;
};

function same(a: unknown, b: unknown): boolean {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

export async function snapshotLiveBnbTestnetFactory(provider: typeof ethers.provider, address = LIVE_97_FACTORY): Promise<LiveFactorySnapshot> {
  const code = await provider.getCode(address);
  const exists = Boolean(code && code !== "0x");
  const codeHash = ethers.keccak256(code || "0x");
  const empty: LiveFactorySnapshot = {
    address: ethers.getAddress(address),
    codeHash,
    exists,
    factoryGeneration: null,
    campaignGeneration: null,
    live: null,
    createPaused: null,
    routeAuthority: null,
    owner: null,
    campaignsCount: null,
    feeRecipient: null,
    router: null,
    permanentLpLocker: null,
    liquidityKind: null,
    protocolFeeBps: null,
  };
  if (!exists) return empty;
  const factory = new ethers.Contract(
    address,
    [
      "function FACTORY_GENERATION() view returns (uint32)",
      "function CAMPAIGN_GENERATION() view returns (uint32)",
      "function live() view returns (bool)",
      "function createPaused() view returns (bool)",
      "function routeAuthority() view returns (address)",
      "function owner() view returns (address)",
      "function campaignsCount() view returns (uint256)",
      "function feeRecipient() view returns (address)",
      "function router() view returns (address)",
      "function permanentLpLocker() view returns (address)",
      "function liquidityKind() view returns (uint8)",
      "function protocolFeeBps() view returns (uint256)",
    ],
    provider,
  );
  const [
    factoryGeneration,
    campaignGeneration,
    live,
    createPaused,
    routeAuthority,
    owner,
    campaignsCount,
    feeRecipient,
    router,
    permanentLpLocker,
    liquidityKind,
    protocolFeeBps,
  ] = await Promise.all([
    factory.FACTORY_GENERATION(),
    factory.CAMPAIGN_GENERATION(),
    factory.live(),
    factory.createPaused(),
    factory.routeAuthority(),
    factory.owner(),
    factory.campaignsCount(),
    factory.feeRecipient(),
    factory.router(),
    factory.permanentLpLocker(),
    factory.liquidityKind(),
    factory.protocolFeeBps(),
  ]);
  return {
    ...empty,
    factoryGeneration: factoryGeneration.toString(),
    campaignGeneration: campaignGeneration.toString(),
    live: Boolean(live),
    createPaused: Boolean(createPaused),
    routeAuthority,
    owner,
    campaignsCount: campaignsCount.toString(),
    feeRecipient,
    router,
    permanentLpLocker,
    liquidityKind: liquidityKind.toString(),
    protocolFeeBps: protocolFeeBps.toString(),
  };
}

export function assertLiveFactorySnapshotUnchanged(before: LiveFactorySnapshot, after: LiveFactorySnapshot) {
  const keys = Object.keys(before) as (keyof LiveFactorySnapshot)[];
  for (const key of keys) {
    if (!same(before[key], after[key])) {
      throw new Error(`live 3/2 factory ${key} changed during 6C: before=${before[key]} after=${after[key]}`);
    }
  }
}

export function assertNewStackAvoidsLiveAddresses(addresses: string[]) {
  for (const value of addresses) {
    for (const live of PROTECTED_LIVE_ADDRESSES) {
      if (same(value, live)) throw new Error(`6C stack reused live BNB address ${live}`);
    }
  }
}
