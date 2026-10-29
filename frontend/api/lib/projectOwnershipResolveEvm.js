import { Interface, getAddress, isAddress } from "ethers";
import { resolveEvmProjectAuthority } from "./projectImportEvmCreator.js";

// Import-only EVM authority resolver. Intentionally has no launch, market-routing, graduation, claims or Arena dependency.
export const AUTOMATIC_EVM_OWNERSHIP_UNAVAILABLE = "automatic ownership verification unavailable";

const TOKEN_READ_INTERFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
]);

function normalizeEvmAddress(value, label) {
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
  return TOKEN_READ_INTERFACE.decodeFunctionResult(method, raw)[0];
}

async function optionalRead(provider, contractAddress, method) {
  try { return { readable: true, value: await callRead(provider, contractAddress, method) }; }
  catch { return { readable: false, value: null }; }
}

// Owner, token deployer/creator wallet, then a verified launchpad creator: see projectImportEvmCreator.js.
async function resolveCurrentOwner(provider, contractAddress, signedWallet, chainId) {
  return resolveEvmProjectAuthority({ provider, chainId, token: contractAddress, signedWallet: signedWallet });
}

export async function resolveProjectOwnershipEvm({ provider, chainId, contractAddress, signedConnectedWallet }) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("A valid EVM chain id is required.");
  if (!provider || typeof provider.getCode !== "function" || typeof provider.call !== "function") throw new TypeError("A read-only EVM provider is required.");
  const tokenAddress = normalizeEvmAddress(contractAddress, "contract address");
  const signedWallet = normalizeEvmAddress(signedConnectedWallet, "signed connected wallet");

  if (typeof provider.getNetwork === "function") {
    try {
      const network = await provider.getNetwork();
      if (Number(network?.chainId) !== id) {
        return { ok:false, chainId:id, contractAddress:tokenAddress, errorCode:"PROJECT_IMPORT_CHAIN_MISMATCH", error:`Configured RPC is chain ${String(network?.chainId ?? "unknown")}, expected ${id}.` };
      }
    } catch (error) {
      return { ok:false, chainId:id, contractAddress:tokenAddress, errorCode:"BYTECODE_CHECK_FAILED", error:String(error?.message || error || "RPC chain check failed.") };
    }
  }

  let bytecode;
  try { bytecode = await provider.getCode(tokenAddress); }
  catch (error) {
    return { ok:false, chainId:id, contractAddress:tokenAddress, errorCode:"BYTECODE_CHECK_FAILED", error:String(error?.message || error || "Bytecode check failed.") };
  }
  if (!hasDeployedBytecode(bytecode)) return { ok:false, chainId:id, contractAddress:tokenAddress, errorCode:"NO_DEPLOYED_BYTECODE", error:"No deployed bytecode exists at the supplied contract address." };

  const [nameRead, symbolRead, decimalsRead, supplyRead] = await Promise.all([
    optionalRead(provider, tokenAddress, "name"),
    optionalRead(provider, tokenAddress, "symbol"),
    optionalRead(provider, tokenAddress, "decimals"),
    optionalRead(provider, tokenAddress, "totalSupply"),
  ]);
  if (!symbolRead.readable || !decimalsRead.readable) return { ok:false, chainId:id, contractAddress:tokenAddress, errorCode:"ERC20_READ_FAILED", error:"Required ERC20 symbol() or decimals() read is unavailable." };
  const decimals = Number(decimalsRead.value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return { ok:false, chainId:id, contractAddress:tokenAddress, errorCode:"ERC20_DECIMALS_INVALID", error:"ERC20 decimals() returned an invalid value." };

  const ownership = await resolveCurrentOwner(provider, tokenAddress, signedWallet, Number(chainId));
  return {
    ok:true,
    chainId:id,
    contractAddress:tokenAddress,
    token:{
      name:nameRead.readable ? String(nameRead.value) : null,
      symbol:String(symbolRead.value),
      decimals,
      totalSupply:supplyRead.readable ? String(supplyRead.value) : null,
    },
    ownership,
  };
}
