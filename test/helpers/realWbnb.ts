/**
 * Real WBNB (WETH9) runtime bytecode, read from BSC with eth_getCode (test/fixtures/wrapped-native-bytecode.json),
 * installed at its mainnet address on the plain hardhat network. WETH9 pays `withdraw` out with `transfer`
 * (2300 gas stipend), which is the constraint ProtocolRevenueForwarder.receive() must meet.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

export const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FIXTURE = path.join(__dirname, "..", "fixtures", "wrapped-native-bytecode.json");

function shortString(s: string): string {
  // Solidity storage layout of a string shorter than 32 bytes: data left-aligned, length * 2 in the last byte.
  const bytes = ethers.toUtf8Bytes(s);
  const word = new Uint8Array(32);
  word.set(bytes, 0);
  word[31] = bytes.length * 2;
  return ethers.hexlify(word);
}

/** Real WBNB (WETH9) runtime code at its mainnet address; storage set as its initializers would have. */
export async function installRealWbnb() {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  await network.provider.send("hardhat_setCode", [WBNB_ADDRESS, fx.wbnb.code]);
  await network.provider.send("hardhat_setStorageAt", [WBNB_ADDRESS, ethers.toBeHex(0n, 32), shortString("Wrapped BNB")]);
  await network.provider.send("hardhat_setStorageAt", [WBNB_ADDRESS, ethers.toBeHex(1n, 32), shortString("WBNB")]);
  await network.provider.send("hardhat_setStorageAt", [WBNB_ADDRESS, ethers.toBeHex(2n, 32), ethers.toBeHex(18n, 32)]);
  return ethers.getContractAt(
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
      "function deposit() payable",
      "function withdraw(uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function approve(address,uint256) returns (bool)",
    ],
    WBNB_ADDRESS,
  );
}
