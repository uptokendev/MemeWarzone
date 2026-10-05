import { ExternalLink } from "lucide-react";
import { openCookieSettings, setCookieConsent, useCookieConsent } from "@/lib/cookieConsent";
import type { ProfileStream } from "@/hooks/useProfileStream";
import { kickChannelUrl, kickChatUrl, kickPlayerUrl } from "../../../shared/profileStreams.mjs";

/** Tab label: red LIVE that flashes while the channel is live. */
export function LiveTabLabel() {
  return (
    <span className="inline-flex items-center gap-1.5 font-bold text-[#FF3B3B]">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF3B3B] opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF3B3B]" />
      </span>
      <span className="animate-pulse">LIVE</span>
    </span>
  );
}

export function ProfileLiveStream({ stream }: { stream: ProfileStream }) {
  const consent = useCookieConsent();
  const channelUrl = kickChannelUrl(stream.channel);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="m-0 truncate text-[15px] font-semibold text-mw-text">{stream.title || `${stream.channel} on Kick`}</p>
        <p className="m-0 text-xs text-mw-muted">
          kick.com/{stream.channel}
          {stream.viewers != null ? ` · ${stream.viewers.toLocaleString()} watching` : ""}
        </p>
      </div>
      <a href={channelUrl} target="_blank" rel="noopener noreferrer" className="mw-focus inline-flex items-center gap-1 text-sm text-mw-accent-soft underline">
        Open on Kick <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );

  if (consent !== "accepted") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-[14px] border border-mw-border bg-mw-surface px-6 text-center font-mw-body">
          <p className="m-0 max-w-md text-[15px] text-mw-text">This stream plays in Kick's player, and Kick sets cookies when it loads.</p>
          <p className="m-0 max-w-md text-sm text-mw-muted">
            {consent === "declined" ? "You declined cookies, so the player is off." : "Accept cookies to watch here."} You can also watch on kick.com.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => setCookieConsent("accepted")}
              className="mw-focus min-h-10 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
            >
              Accept cookies
            </button>
            <button
              type="button"
              onClick={openCookieSettings}
              className="mw-focus min-h-10 rounded-[10px] border border-mw-border bg-mw-ground px-4 text-sm font-semibold text-mw-text hover:border-mw-edge"
            >
              Cookie settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="aspect-video w-full overflow-hidden rounded-[14px] border border-mw-border bg-black">
          <iframe
            src={kickPlayerUrl(stream.channel)}
            title={`${stream.channel} live on Kick`}
            className="h-full w-full"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
        <div className="h-[420px] overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface 2xl:h-auto">
          <iframe src={kickChatUrl(stream.channel)} title={`${stream.channel} chat on Kick`} className="h-full w-full" referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      </div>
    </div>
  );
}
