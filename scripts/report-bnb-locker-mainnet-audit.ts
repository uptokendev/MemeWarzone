import { ethers } from "ethers";

const RPC = process.env.BSC_MAINNET_RPC || process.env.BNB_FORK_RPC || "https://bsc-dataseed.binance.org";
const LOCKER = "0x64710A4f87aBa3b5ED5B8B25e8ebA4DaC339C998";
const FACTORY = "0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a";
const IMPL = "0xbe3caF640F77e8436BCAF89730251A00fB01608f";
const ADAPTER = "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a";
const TOPAZ_FACTORY = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true, batchMaxCount: 1 });
  const iface = new ethers.Interface([
    "function REQUIRED_POOL_FEE_BPS() view returns (uint16)",
    "function CREATOR_FEE_BPS() view returns (uint16)",
    "function PROTOCOL_FEE_BPS() view returns (uint16)",
  ]);
  const calls = ["REQUIRED_POOL_FEE_BPS", "CREATOR_FEE_BPS", "PROTOCOL_FEE_BPS"] as const;
  console.log("block", await p.getBlockNumber());
  for (const fn of calls) {
    const data = iface.encodeFunctionData(fn);
    const result = await p.send("eth_call", [{ to: LOCKER, data }, "latest"]);
    console.log(JSON.stringify({ fn, to: LOCKER, data, result, value: Number(BigInt(result)) }));
  }
  const topaz = new ethers.Contract(TOPAZ_FACTORY, ["function getFee(address,bool) view returns (uint256)"], p);
  console.log("topaz.getFee(0,false)", (await topaz.getFee(ethers.ZeroAddress, false)).toString());
  for (const [label, addr] of [
    ["factory", FACTORY],
    ["locker", LOCKER],
    ["campaignImpl", IMPL],
    ["adapter", ADAPTER],
  ] as const) {
    const code = await p.getCode(addr);
    console.log(label, addr, "bytes", (code.length - 2) / 2, "keccak", ethers.keccak256(code));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
