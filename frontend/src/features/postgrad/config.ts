const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readFlag(value: string | undefined, fallback = false) {
  if (value == null || value.trim() === "") return fallback;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

const isLocalDev = import.meta.env.DEV === true;

// Post-grad battle features are a later release and must remain explicitly gated,
// including during local development.
const postGradEnabled = readFlag(import.meta.env.VITE_ENABLE_POSTGRAD, false);

// Trade War Room ships with the launchpad. Its rollout is independent from the
// later post-grad Arena/battle system. Keep the former post-grad variable as a
// deployment-compatible fallback while environments migrate to the correct name.
const warRoomFlag =
  import.meta.env.VITE_ENABLE_WAR_ROOM?.trim() ||
  import.meta.env.VITE_ENABLE_POSTGRAD_WAR_ROOM;
export const warRoomEnabled = readFlag(warRoomFlag, isLocalDev);

// The first launch is the launchpad plus Trade War Room. Arena surfaces stay
// hidden by default until the Arena rollout is explicitly enabled.
const arenaEnabled = postGradEnabled && readFlag(import.meta.env.VITE_ENABLE_POSTGRAD_ARENA, false);

export const postGradFlags = {
  enabled: postGradEnabled,
  arena: arenaEnabled,
  // Per-surface flags default ON once Arena is enabled. Set an explicit false to hide one product.
  battle: arenaEnabled && readFlag(import.meta.env.VITE_ENABLE_POSTGRAD_BATTLE, true),
  events: arenaEnabled && readFlag(import.meta.env.VITE_ENABLE_POSTGRAD_EVENTS, true),
  league: arenaEnabled && readFlag(import.meta.env.VITE_ENABLE_POSTGRAD_LEAGUE, true),
  tournament: arenaEnabled && readFlag(import.meta.env.VITE_ENABLE_POSTGRAD_TOURNAMENT, true),
  // Mock-only UX should be explicit opt-in so the branch defaults to the real
  // post-grad route structure, API adapters, and honest empty states.
  mocks: postGradEnabled && readFlag(import.meta.env.VITE_ENABLE_POSTGRAD_MOCKS, false),
} as const;

export function isPostGradRouteEnabled() {
  return postGradFlags.enabled;
}

export function isPostGradNavEnabled() {
  return postGradFlags.enabled && postGradFlags.arena;
}
