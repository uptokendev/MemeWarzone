import { JsonRpcProvider, isAddress } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function csvEnv(...names) {
  return firstEnv(...names)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function unique(values, normalizer = (value) => value) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizer(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function bnbRewardCustody(network) {
  const suffix = network.chainId === 97 ? "97" : "56";
  const explicit = csvEnv(`FINANCE_REWARD_CUSTODY_ADDRESSES_${suffix}`)
    .filter((value) => isAddress(value));
  if (explicit.length > 0) return unique(explicit, (value) => value.toLowerCase());

  const distributor = firstEnv(
    `REWARD_DISTRIBUTOR_ADDRESS_${suffix}`,
    `VITE_REWARD_DISTRIBUTOR_ADDRESS_${suffix}`,
    ...(network.chainId === 97 ? ["BNB_TESTNET_REWARD_DISTRIBUTOR_ADDRESS"] : []),
    ...(network.chainId === 56 ? ["BNB_REWARD_DISTRIBUTOR_ADDRESS", "REWARD_DISTRIBUTOR_ADDRESS_BNB", "REWARD_DISTRIBUTOR_ADDRESS", "VITE_REWARD_DISTRIBUTOR_ADDRESS"] : []),
  );
  return isAddress(distributor) ? [distributor] : [];
}

function bnbRpcUrls(network) {
  const suffix = network.chainId === 97 ? "97" : "56";
  return unique(csvEnv(`BSC_RPC_HTTP_${suffix}`, `VITE_PUBLIC_RPC_${suffix}`));
}

function assertCurrentSolanaFinanceNetwork(network) {
  if (Number(network?.chainId) !== 101) {
    throw new Error("Solana finance funding requires canonical chain 101.");
  }
  if (network.environment === "staging" && network.cluster === "devnet") return "staging";
  if (network.environment === "production" && network.cluster === "mainnet-beta") return "production";
  throw new Error("Solana finance funding requires explicit staging/devnet or production/mainnet-beta authority.");
}

function solanaRewardCustody(network) {
  const environment = assertCurrentSolanaFinanceNetwork(network);
  const explicit = csvEnv(
    environment === "staging"
      ? "FINANCE_REWARD_CUSTODY_ADDRESSES_101_DEVNET"
      : "FINANCE_REWARD_CUSTODY_ADDRESSES_101_MAINNET",
    "FINANCE_REWARD_CUSTODY_ADDRESSES_101",
  );
  if (explicit.length > 0) return unique(explicit);

  const names = environment === "staging"
    ? ["SOLANA_DEVNET_REWARD_VAULT_ADDRESS", "SOLANA_REWARD_VAULT_ADDRESS"]
    : ["SOLANA_MAINNET_REWARD_VAULT_ADDRESS"];
  const values = names.map((name) => firstEnv(name)).filter(Boolean);
  return unique(values);
}

function solanaRpcUrls(network) {
  const environment = assertCurrentSolanaFinanceNetwork(network);
  const names = environment === "staging"
    ? ["SOLANA_DEVNET_RPC_HTTP", "SOLANA_RPC_HTTP"]
    : ["SOLANA_MAINNET_RPC_HTTP"];
  return unique(csvEnv(...names));
}

async function readBnbBalanceFromRpc(rpcUrl, addresses) {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  let total = 0n;
  for (const address of addresses) total += await provider.getBalance(address);
  return total;
}

async function readSolanaBalanceFromRpc(rpcUrl, addresses) {
  const connection = new Connection(rpcUrl, "confirmed");
  let total = 0n;
  for (const address of addresses) {
    const lamports = await connection.getBalance(new PublicKey(address), "confirmed");
    total += BigInt(lamports);
  }
  return total;
}

export function configuredRewardVaultAddresses(network) {
  if (network.chain === "bnb") return bnbRewardCustody(network);
  if (network.chain === "solana") return solanaRewardCustody(network);
  return [];
}

export async function readRewardFunding(network) {
  const addresses = configuredRewardVaultAddresses(network);
  const rpcUrls = network.chain === "bnb"
    ? bnbRpcUrls(network)
    : network.chain === "solana"
      ? solanaRpcUrls(network)
      : [];

  if (addresses.length === 0) {
    return {
      configured: false,
      readable: false,
      vaultCount: 0,
      fundedRaw: 0n,
      error: "Approved reward claim custody is not configured for the selected network.",
    };
  }
  if (rpcUrls.length === 0) {
    return {
      configured: true,
      readable: false,
      vaultCount: addresses.length,
      fundedRaw: 0n,
      error: "Reward funding RPC is not configured for the selected network.",
    };
  }

  let lastError = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const fundedRaw = network.chain === "bnb"
        ? await readBnbBalanceFromRpc(rpcUrl, addresses)
        : await readSolanaBalanceFromRpc(rpcUrl, addresses);
      return {
        configured: true,
        readable: true,
        vaultCount: addresses.length,
        fundedRaw,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    configured: true,
    readable: false,
    vaultCount: addresses.length,
    fundedRaw: 0n,
    error: String(lastError?.message || lastError || "Reward funding balance read failed."),
  };
}
