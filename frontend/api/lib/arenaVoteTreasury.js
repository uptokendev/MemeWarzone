import { isAddress, isSolanaAddress } from "../../server/http.js";

const LAUNCHPAD_EVM = [
  "0xF6AA6eD33030F1179B57658f45dd48E31a60E70f",
  "0xBa593e2aC9A728474bcbAe82Bc6c57B8034008b1",
];

function envList(...keys) {
  return keys
    .map((key) => String(process.env[key] || "").trim())
    .filter(Boolean);
}

export function launchpadEvmTreasuries() {
  const out = new Set(LAUNCHPAD_EVM.map((value) => value.toLowerCase()));
  for (const value of envList(
    "VOTE_TREASURY_ADDRESS_56",
    "VITE_VOTE_TREASURY_ADDRESS_56",
    "VOTE_TREASURY_ADDRESS_97",
    "VITE_VOTE_TREASURY_ADDRESS_97",
    "VOTE_TREASURY_ADDRESS",
    "VITE_VOTE_TREASURY_ADDRESS",
  )) {
    if (isAddress(value)) out.add(value.toLowerCase());
  }
  return out;
}

export function launchpadSolanaTreasuries() {
  return envList(
    "SOLANA_VOTE_TREASURY_ADDRESS",
    "VITE_SOLANA_VOTE_TREASURY_ADDRESS",
    "VITE_VOTE_TREASURY_ADDRESS_101",
    "VOTE_TREASURY_ADDRESS_101",
  ).filter((value) => isSolanaAddress(value));
}

export function arenaEvmTreasury(chainId) {
  const id = Number(chainId);
  const value = envList(
    `ARENA_VOTE_TREASURY_ADDRESS_${id}`,
    `VITE_ARENA_VOTE_TREASURY_ADDRESS_${id}`,
    "ARENA_VOTE_TREASURY_ADDRESS",
    "VITE_ARENA_VOTE_TREASURY_ADDRESS",
  )[0] || "";
  return value && isAddress(value) ? value.toLowerCase() : "";
}

export function arenaSolanaTreasuries() {
  const out = [];
  const seen = new Set();
  // Destination is the protocol treasury (same route as launchpad UP Votes).
  // Isolation is the memo prefix mwz-arena-upvote:, not a second wallet.
  for (const value of envList(
    "SOLANA_ARENA_VOTE_TREASURY_ADDRESS",
    "VITE_SOLANA_ARENA_VOTE_TREASURY_ADDRESS",
    "ARENA_VOTE_TREASURY_ADDRESS_101",
    "VITE_ARENA_VOTE_TREASURY_ADDRESS_101",
    "SOLANA_PROTOCOL_TREASURY_ADDRESS",
    "VITE_SOLANA_PROTOCOL_TREASURY_ADDRESS",
    "SOLANA_DEVNET_PROTOCOL_TREASURY_ADDRESS",
    "SOLANA_MAINNET_PROTOCOL_TREASURY_ADDRESS",
    "SOLANA_VOTE_TREASURY_ADDRESS",
    "VITE_SOLANA_VOTE_TREASURY_ADDRESS",
    "VITE_VOTE_TREASURY_ADDRESS_101",
  )) {
    if (!isSolanaAddress(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function arenaVotingConfigured() {
  return Boolean(arenaEvmTreasury(56) || arenaEvmTreasury(97) || arenaSolanaTreasuries()[0]);
}

export function assertArenaEvmTreasury(chainId) {
  const arena = arenaEvmTreasury(chainId);
  if (!arena) return { ok: false, error: "Arena vote treasury is not configured for this chain.", code: "ARENA_VOTE_TREASURY_MISSING" };
  if (launchpadEvmTreasuries().has(arena)) {
    return { ok: false, error: "Arena vote treasury must not reuse the launchpad UPVoteTreasury address.", code: "ARENA_VOTE_TREASURY_COLLISION" };
  }
  return { ok: true, treasury: arena };
}

export function assertArenaSolanaTreasury() {
  const treasuries = arenaSolanaTreasuries();
  if (!treasuries.length) {
    return { ok: false, error: "Solana protocol treasury is not configured for Arena UpVotes.", code: "ARENA_VOTE_TREASURY_MISSING" };
  }
  return { ok: true, treasuries };
}
