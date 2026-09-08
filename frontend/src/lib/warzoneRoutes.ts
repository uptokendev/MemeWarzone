/** Public post-grad hub. Pitch: a graduated coin enters the full Warzone. */
export const WARZONE_ROOT = "/warzone";

export function warzonePath(rest = "") {
  const tail = String(rest || "").replace(/^\/+/, "");
  return tail ? `${WARZONE_ROOT}/${tail}` : WARZONE_ROOT;
}

export function isWarzonePath(pathname: string) {
  const path = String(pathname || "");
  return path === WARZONE_ROOT || path.startsWith(`${WARZONE_ROOT}/`) || path === "/arena" || path.startsWith("/arena/");
}
