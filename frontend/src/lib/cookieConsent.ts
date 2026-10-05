import { useSyncExternalStore } from "react";

// Cookie consent for third-party embeds (founder, 2026-10-06). "accepted" lets Kick's player load on
// streamer profiles; "declined" or no answer keeps it off. The choice itself is kept in localStorage
// (needed to remember the answer, so it does not require consent).

export type CookieConsent = "accepted" | "declined" | null;

const STORAGE_KEY = "mwz:cookieConsent:v1";
const CHANGE_EVENT = "mwz:cookie-consent-change";
const OPEN_EVENT = "mwz:cookie-consent-open";

function read(): CookieConsent {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "accepted" || value === "declined" ? value : null;
  } catch {
    return null;
  }
}

export function setCookieConsent(value: Exclude<CookieConsent, null>) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Private mode: the choice lasts for this page only.
    memoryValue = value;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

let memoryValue: CookieConsent = null;

function snapshot(): CookieConsent {
  return read() ?? memoryValue;
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCookieConsent(): CookieConsent {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Opens the consent banner again (the cookie button, or the notice on a stream). */
export function openCookieSettings() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenCookieSettings(handler: () => void) {
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}
