import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui-v2";
import { cp } from "@/components/token/coinPageStyles";
import { fetchMyHandle, type MyHandle } from "@/lib/handlesApi";
import { UsernameForm } from "./UsernameForm";

function formatDate(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Settings: the wallet's @username with Set / Change (founder, 2026-10-02). Hidden while the API has no usernames. */
export function UsernameSettingsRow({ wallet }: { wallet: string }) {
  const [state, setState] = useState<MyHandle | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    fetchMyHandle(wallet)
      .then((r) => {
        if (!cancelled) setState(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  if (!state?.supported) return null;
  const coolingDown = Boolean(state.handle && state.nextChangeAt && Date.now() < new Date(state.nextChangeAt).getTime());

  return (
    <div className="flex flex-col gap-1.5" data-username-settings="true">
      <span className={cp.label}>Username</span>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-11 min-w-0 flex-1 items-center rounded-[10px] border border-mw-border bg-mw-input px-3 font-mw-mono text-[15px]">
          {state.handle ? `@${state.handle}` : <span className="text-mw-muted">Not set. Nobody can tag you yet.</span>}
        </div>
        <button type="button" onClick={() => setOpen(true)} className={cp.btn}>
          {state.handle ? "Change" : "Set username"}
        </button>
      </div>
      {coolingDown ? <p className="m-0 text-xs text-mw-muted">Next change possible on {formatDate(state.nextChangeAt)}.</p> : null}
      <Modal open={open} onOpenChange={setOpen} title={state.handle ? "Change your username" : "Pick your username"} description="Your @username is how people tag you in posts.">
        <UsernameForm
          wallet={wallet}
          current={state.handle}
          onSaved={(handle) => {
            setOpen(false);
            toast.success(`You are @${handle}`);
            void fetchMyHandle(wallet).then(setState).catch(() => {});
          }}
        />
      </Modal>
    </div>
  );
}
