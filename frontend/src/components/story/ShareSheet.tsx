import { useState } from "react";

export function xShareHref(share: { url: string; text: string }) {
  return `https://x.com/intent/post?text=${encodeURIComponent(share.text)}&url=${encodeURIComponent(share.url)}`;
}

export function telegramShareHref(share: { url: string; text: string }) {
  return `https://t.me/share/url?url=${encodeURIComponent(share.url)}&text=${encodeURIComponent(share.text)}`;
}

export function ShareSheet({
  share,
  coinName,
  onClose,
}: {
  share: { url: string; text: string; imageUrl: string };
  coinName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const canMore = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setFallback(false);
    } catch {
      setFallback(true);
      setCopied(false);
    }
  };

  const more = async () => {
    try {
      await navigator.share({ title: coinName, text: share.text, url: share.url });
    } catch {
      /* user cancelled */
    }
  };

  return (
    <div className="share-sheet" role="dialog" aria-label="Share this story">
      <button type="button" className="share-dismiss" onClick={onClose} aria-label="Close" />
      <div className="share-panel">
        {share.imageUrl ? <img className="share-preview" src={share.imageUrl} alt="" /> : null}
        <a className="cta main" href={xShareHref(share)} target="_blank" rel="noreferrer">
          Share on X
        </a>
        <a className="cta alt" href={telegramShareHref(share)} target="_blank" rel="noreferrer">
          Telegram
        </a>
        <button type="button" className="cta alt" onClick={() => void copy()}>
          Copy link
        </button>
        {canMore ? (
          <button type="button" className="cta alt" onClick={() => void more()}>
            More…
          </button>
        ) : null}
        {copied ? <div className="share-toast">Link copied</div> : null}
        {fallback ? <input className="share-fallback" readOnly value={share.url} /> : null}
      </div>
    </div>
  );
}
