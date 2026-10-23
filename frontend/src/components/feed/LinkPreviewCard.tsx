/**
 * Preview card for the first link in a feed post (title, image, domain), like X shows. Data comes from
 * GET /api/link-preview (api/linkPreview.js), which fetches public pages only. Renders nothing while loading or
 * when the page has no title and no image. The post itself is clickable, so this is a role=link div that stops
 * the post click: MemeWarzone links open in the app, outside links in a new tab.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { apiFetch } from "@/lib/apiBase";
import { firstLink, openPostLink } from "../../../shared/postLinks.mjs";

type Preview = { ok: boolean; url: string; domain?: string; title?: string; description?: string; image?: string | null; siteName?: string | null };

export function LinkPreviewCard({ text }: { text?: string | null }) {
  const navigate = useNavigate();
  const href = firstLink(String(text || ""));
  const { data } = useQuery<Preview | null>({
    queryKey: ["link-preview", href],
    enabled: Boolean(href),
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await apiFetch(`/api/link-preview?url=${encodeURIComponent(String(href))}`);
      if (!res.ok) return null;
      return (await res.json()) as Preview;
    },
  });
  if (!href || !data?.ok || (!data.title && !data.image)) return null;

  const open = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openPostLink(href, navigate);
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") open(event);
      }}
      className="mw-focus mt-3 block cursor-pointer overflow-hidden rounded-[14px] border border-mw-border bg-mw-input hover:border-[#3A424C]"
      data-link-preview="true"
    >
      {data.image ? (
        <img
          src={data.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="aspect-[1.91/1] w-full border-b border-mw-border bg-[#0B0D10] object-cover"
          onError={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-[12px] text-mw-muted">
          <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{data.siteName || data.domain}</span>
        </div>
        {data.title ? <div className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug text-mw-text">{data.title}</div> : null}
        {data.description ? <div className="mt-1 line-clamp-2 text-[13px] leading-5 text-mw-muted">{data.description}</div> : null}
      </div>
    </div>
  );
}
