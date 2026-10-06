import { useEffect, useState } from "react";
import { Cookie } from "lucide-react";
import { onOpenCookieSettings, setCookieConsent, useCookieConsent } from "@/lib/cookieConsent";

// Bottom banner until the visitor answers; after that a small cookie button bottom right reopens it.
export function CookieConsentBanner() {
  const consent = useCookieConsent();
  const [reopened, setReopened] = useState(false);

  useEffect(() => onOpenCookieSettings(() => setReopened(true)), []);

  const choose = (value: "accepted" | "declined") => {
    setCookieConsent(value);
    setReopened(false);
  };

  if (consent === null || reopened) {
    return (
      <div
        role="dialog"
        aria-live="polite"
        aria-label="Cookie settings"
        className="fixed inset-x-0 bottom-[var(--mwz-footer-offset,0px)] z-[85] border-t border-mw-border bg-mw-ground/95 px-4 py-3 font-mw-body backdrop-blur lg:bottom-0 lg:pl-[calc(var(--mwz-left-sidebar-width,0px)+1rem)]"
      >
        <div className="mx-auto flex max-w-[1180px] flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="m-0 text-[13px] leading-snug text-mw-muted">
            Our website uses third-party cookies to make your experience better and more fun, like watching live
            streams right here. If you decline, those features stay off. You can change your choice any time with
            the cookie button in the bottom right corner.
            {consent ? <span className="ml-1 text-mw-text">Current setting: {consent === "accepted" ? "accepted" : "declined"}.</span> : null}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => choose("declined")}
              className="mw-focus min-h-10 rounded-[10px] border border-mw-border bg-mw-surface px-4 text-sm font-semibold text-mw-text hover:border-mw-edge"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => choose("accepted")}
              className="mw-focus min-h-10 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setReopened(true)}
      aria-label="Cookie settings"
      title="Cookie settings"
      className="mw-focus fixed bottom-[calc(var(--mwz-footer-offset,0px)+72px)] right-3 z-[85] flex h-9 w-9 items-center justify-center rounded-full border border-mw-border bg-mw-surface text-mw-muted shadow-[0_8px_20px_-10px_rgba(0,0,0,0.9)] hover:text-mw-text lg:bottom-4 lg:right-4"
    >
      <Cookie className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
