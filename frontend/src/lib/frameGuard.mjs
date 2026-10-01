// The app signs wallet transactions, so it must not run inside another site's frame (clickjacking).
// Only the partner chart (/embed/chart/...) may be framed. The real protection is the server header
// (CSP frame-ancestors); this is the in-app fallback while the static host sends no such header.

export function isFramed(win) {
  try {
    return win.self !== win.top;
  } catch {
    // Reading top across origins throws: we are framed by another origin.
    return true;
  }
}

export function frameAllowedPath(pathname) {
  const path = String(pathname || "").split("?")[0];
  return path.startsWith("/embed/chart/");
}

/** True when the app must refuse to render: framed, and not on the embeddable chart route. */
export function shouldRefuseFramed(win) {
  return isFramed(win) && !frameAllowedPath(win.location?.pathname);
}
