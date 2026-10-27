import { useState } from "react";
import { toast } from "sonner";

import { cp } from "@/components/token/coinPageStyles";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const WIDGET_SCRIPT = "https://app.memewar.zone/widget/mwz-swap.js";
const WIDGET_GUIDE = "https://docs.memewar.zone/creators/swap-widget";
const WIDGET_EXAMPLE = "https://app.memewar.zone/widget/example.html";

/** Chains the swap box trades on (mwz-swap.js): Solana by mint, BNB Chain and Robinhood Chain by chainId + token. */
const WIDGET_NATIVE: Record<number, string> = { 101: "SOL", 56: "BNB", 4663: "ETH" };

export function swapWidgetChainSupported(chainId: number | string | null | undefined): boolean {
  return Number(chainId) in WIDGET_NATIVE;
}

export function swapWidgetSnippet(chainId: number, token: string) {
  const options = chainId === 101 ? `{ mint: "${token}" }` : `{ chainId: ${chainId}, token: "${token}" }`;
  return `<div id="mwz-swap"></div>
<script src="${WIDGET_SCRIPT}"></script>
<script>
  MemeWarzoneSwap.mount("#mwz-swap", ${options});
</script>`;
}

function swapWidgetExampleUrl(chainId: number, token: string) {
  return chainId === 101
    ? `${WIDGET_EXAMPLE}?mint=${encodeURIComponent(token)}`
    : `${WIDGET_EXAMPLE}?chainId=${chainId}&token=${encodeURIComponent(token)}`;
}

/**
 * "On your website?" link next to the Trade title of a coin the widget can trade: imports on Solana, BNB Chain and
 * Robinhood Chain, our Solana launchpad / DBC coins on their curve, and generation 8 coins on BNB Chain and Robinhood
 * Chain. A dialog with the swap box code for this coin (src/widget).
 */
export function SwapWidgetEmbedLink({
  chainId,
  token,
  symbol,
  bonding = false,
}: {
  chainId: number;
  token: string;
  symbol?: string | null;
  bonding?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const snippet = swapWidgetSnippet(chainId, token);
  const name = symbol ? `$${symbol}` : "this coin";
  const native = WIDGET_NATIVE[chainId] ?? "the chain's native coin";

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success("Code copied.");
    } catch {
      toast.error("Copy failed. Select the code and copy it by hand.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-semibold text-mw-accent underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
        data-swap-widget-link="true"
      >
        On your website?
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" data-swap-widget-dialog="true">
          <DialogHeader>
            <DialogTitle>Put this trade panel on your website</DialogTitle>
            <DialogDescription>
              Let people buy and sell {name} on your own site, with their own wallet.
            </DialogDescription>
          </DialogHeader>
          <ol className="m-0 list-decimal space-y-1 pl-5 text-sm text-mw-muted">
            <li>Copy the code below. It already contains this coin.</li>
            <li>On your website, add a <b className="text-mw-text">Custom HTML</b> or <b className="text-mw-text">Embed code</b> block.</li>
            <li>Paste the code and publish the page.</li>
          </ol>
          <pre className="m-0 overflow-x-auto whitespace-pre rounded-md border border-[#2E353D] bg-mw-input p-3 font-mw-mono text-[12px] leading-relaxed text-mw-text" data-swap-widget-snippet="true">
            {snippet}
          </pre>
          <Button type="button" className={`${cp.btn} border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`} onClick={() => void copy()}>
            COPY CODE
          </Button>
          <p className="m-0 text-sm text-mw-muted">
            {bonding
              ? "Trades through the panel pay the same fees as on MemeWarzone, and the creator gets the same creator share."
              : `Every swap through the panel pays 1%. Half of it goes to the coin's creator, paid in ${native} once the coin is claimed on MemeWarzone.`}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a className="text-mw-accent underline-offset-2 hover:underline" href={swapWidgetExampleUrl(chainId, token)} target="_blank" rel="noopener noreferrer">
              Try it first
            </a>
            <a className="text-mw-accent underline-offset-2 hover:underline" href={WIDGET_GUIDE} target="_blank" rel="noopener noreferrer">
              Full guide
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
