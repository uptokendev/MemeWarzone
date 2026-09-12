import { Interface, ZeroAddress, getAddress, isAddress } from "ethers";

export const BNB_PROJECT_OWNERSHIP_CHAIN_ID = 56;
export const AUTOMATIC_OWNERSHIP_UNAVAILABLE = "automatic ownership verification unavailable";

const TOKEN_READ_INTERFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
]);

function normalizeAddress(value, label) {
  const raw = String(value || "").trim();
  if (!isAddress(raw)) throw new TypeError(`Invalid ${label}.`);
  return getAddress(raw);
}

function hasDeployedBytecode(code) {
  const normalized = String(code || "").trim().toLowerCase();
  return /^0x[0-9a-f]+$/.test(normalized) && !/^0x0*$/.test(normalized);
}

async function callRead(provider, contractAddress, method) {
  const data = TOKEN_READ_INTERFACE.encodeFunctionData(method);
  const raw = await provider.call({ to: contractAddress, data });
  const decoded = TOKEN_READ_INTERFACE.decodeFunctionResult(method, raw);
  return decoded[0];
}

async function optionalRead(provider, contractAddress, method) {
  try { return { readable: true, value: await callRead(provider, contractAddress, method) }; }
  catch { return { readable: false, value: null }; }
}

function unavailableOwnership(method = null) {
  return {
    method,
    currentOwner: null,
    automaticOwnershipVerified: false,
    automaticOwnershipVerification: "unavailable",
    message: AUTOMATIC_OWNERSHIP_UNAVAILABLE,
  };
}

async function resolveCurrentOwner(provider, contractAddress, signedConnectedWallet) {
  const ownerRead = await optionalRead(provider, contractAddress, "owner");
  let method = "owner";
  let rawOwner = ownerRead.value;
  if (!ownerRead.readable) {
    const getOwnerRead = await optionalRead(provider, contractAddress, "getOwner");
    if (!getOwnerRead.readable) return unavailableOwnership();
    method = "getOwner";
    rawOwner = getOwnerRead.value;
  }
  let currentOwner;
  try { currentOwner = normalizeAddress(rawOwner, "current owner"); }
  catch { return unavailableOwnership(method); }
  if (currentOwner === getAddress(ZeroAddress)) return unavailableOwnership(method);
  const verified = currentOwner === signedConnectedWallet;
  return {
    method,
    currentOwner,
    automaticOwnershipVerified: verified,
    automaticOwnershipVerification: verified ? "verified" : "rejected",
    message: verified ? "signed connected wallet matches current owner" : "signed connected wallet does not match current owner",
  };
}

export async function resolveProjectOwnershipBnb({ provider, chainId, contractAddress, signedConnectedWallet, skipOwnership = false }) {
  if (Number(chainId) !== BNB_PROJECT_OWNERSHIP_CHAIN_ID) throw new TypeError("BNB ownership resolver only supports chain 56.");
  if (!provider || typeof provider.getCode !== "function" || typeof provider.call !== "function") throw new TypeError("A read-only EVM provider is required.");
  const tokenAddress = normalizeAddress(contractAddress, "contract address");
  const signedWallet = skipOwnership ? null : normalizeAddress(signedConnectedWallet, "signed connected wallet");
  let bytecode;
  try { bytecode = await provider.getCode(tokenAddress); }
  catch (error) {
    return { ok: false, chainId: 56, contractAddress: tokenAddress, errorCode: "BYTECODE_CHECK_FAILED", error: String(error?.message || error || "Bytecode check failed.") };
  }
  if (!hasDeployedBytecode(bytecode)) return { ok: false, chainId: 56, contractAddress: tokenAddress, errorCode: "NO_DEPLOYED_BYTECODE", error: "No deployed bytecode exists at the supplied contract address." };
  const [nameRead, symbolRead, decimalsRead, supplyRead] = await Promise.all([
    optionalRead(provider, tokenAddress, "name"), optionalRead(provider, tokenAddress, "symbol"), optionalRead(provider, tokenAddress, "decimals"), optionalRead(provider, tokenAddress, "totalSupply"),
  ]);
  if (!symbolRead.readable || !decimalsRead.readable) return { ok: false, chainId: 56, contractAddress: tokenAddress, errorCode: "ERC20_READ_FAILED", error: "Required ERC20 symbol() or decimals() read is unavailable." };
  const decimals = Number(decimalsRead.value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return { ok: false, chainId: 56, contractAddress: tokenAddress, errorCode: "ERC20_DECIMALS_INVALID", error: "ERC20 decimals() returned an invalid value." };
  const ownership = skipOwnership ? unavailableOwnership() : await resolveCurrentOwner(provider, tokenAddress, signedWallet);
  return {
    ok: true,
    chainId: 56,
    contractAddress: tokenAddress,
    token: { name: nameRead.readable ? String(nameRead.value) : null, symbol: String(symbolRead.value), decimals, totalSupply: supplyRead.readable ? String(supplyRead.value) : null },
    ownership,
  };
}
