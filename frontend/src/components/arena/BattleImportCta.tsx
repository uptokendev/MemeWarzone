import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { projectImportRobinhoodEnabled, projectImportsEnabled } from "@/features/projectImports/config";
import type { CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import { ProjectImportPanel } from "@/pages/ProjectImport";

type Props = {
  placement: "header" | "banner";
  walletConnected: boolean;
  loading: boolean;
  creatorStatuses: CreatorBattleStatus[];
};

const CHAINS = projectImportRobinhoodEnabled ? "BNB, Solana or Robinhood" : "BNB or Solana";

// Battles need a graduated or imported coin. This puts the import flow on the
// Battles page so a creator without an eligible coin does not have to hunt for it.
export function BattleImportCta({ placement, walletConnected, loading, creatorStatuses }: Props) {
  const [open, setOpen] = useState(false);
  if (!projectImportsEnabled) return null;

  const hasEligible = creatorStatuses.some((item) => item.eligibility);
  const notReady = creatorStatuses.filter((item) => !item.eligibility);
  const showBanner = !loading && !hasEligible;
  if (placement === "banner" && !showBanner) return null;

  const title = !walletConnected
    ? "Import your memecoin to join the battles"
    : notReady.length
      ? `${notReady.map((item) => (item.symbol ? `$${item.symbol}` : item.tokenName)).slice(0, 3).join(", ")} ${notReady.length === 1 ? "is" : "are"} not battle-ready yet`
      : "You have no coin that can battle yet";
  const body = notReady.length
    ? `Launched coins can battle after they graduate. Imported coins can battle once they pass review. Already trading somewhere else? Import it here.`
    : `Any memecoin already trading on ${CHAINS} can fight here, wherever it launched. Paste the contract address, sign once, and it can battle once it passes review.`;

  return (
    <>
      {placement === "banner" ? (
        <section
          className="flex flex-col gap-3 rounded-[14px] border border-[#FF9A4D]/50 bg-mw-surface p-4 font-mw-body sm:flex-row sm:items-center sm:justify-between"
          data-battle-import-cta="banner"
        >
          <div className="min-w-0">
            <div className="font-mw-cond text-xl font-bold text-mw-text">{title}</div>
            <p className="mt-1 text-[15px] text-mw-muted">{body}</p>
          </div>
          <Button
            type="button"
            className="mw-focus inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
            onClick={() => setOpen(true)}
          >
            <Download className="h-5 w-5" aria-hidden="true" />
            Import your memecoin
          </Button>
        </section>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="mwz-portal-shell max-h-[90vh] w-[calc(100vw-2rem)] max-w-[640px] overflow-y-auto rounded-[18px] border border-mw-edge bg-mw-surface p-5 font-mw-body text-mw-text [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:text-mw-muted [&>button]:opacity-100 [&>button:hover]:text-mw-text">
          <DialogTitle className="font-mw-cond text-2xl font-bold text-mw-text">Import your memecoin</DialogTitle>
          <p className="text-[15px] text-mw-muted">{`Any memecoin on ${CHAINS}, wherever it launched. Once it passes review it can be challenged and can challenge others.`}</p>
          <ProjectImportPanel embedded />
        </DialogContent>
      </Dialog>

      {placement === "header" ? (
        <Button
          type="button"
          variant="outline"
          className="mw-focus inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-input px-4 text-[15px] font-semibold text-mw-text hover:border-mw-accent hover:bg-mw-input hover:text-mw-text"
          data-battle-import-cta="compact"
          onClick={() => setOpen(true)}
        >
          <Download className="h-5 w-5" aria-hidden="true" />
          <span className="lg:hidden">Import</span>
          <span className="hidden lg:inline">Import your memecoin</span>
        </Button>
      ) : null}
    </>
  );
}
