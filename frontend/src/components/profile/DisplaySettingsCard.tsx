import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/apiBase";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { cp } from "@/components/token/coinPageStyles";
import { displayPrefsKey, useDisplayPrefs, type DisplayPrefs } from "@/lib/displayPrefs";

const OPTIONS: Array<{ key: keyof DisplayPrefs; label: string; detail: string }> = [
  { key: "hideNativeAndStables", label: "Hide native coins and stablecoins", detail: "SOL, BNB, ETH, their wrapped versions, USDC, USDT and other stablecoins." },
  { key: "hideSmall", label: "Hide holdings under $1", detail: "Dust and tokens without a price." },
];

/**
 * Portfolio display settings (founder, 2026-10-03): what the Command Center and your public profile
 * list. Total value still counts everything. Saved with a wallet signature, like the notification settings.
 */
export function DisplaySettingsCard({
  walletAddress,
  chainId,
  evmWallet,
  solanaAccount,
}: {
  walletAddress: string;
  chainId?: number | null;
  evmWallet: any;
  solanaAccount?: string | null;
}) {
  const client = useQueryClient();
  const { supported, prefs: saved } = useDisplayPrefs(walletAddress);
  const [prefs, setPrefs] = useState<DisplayPrefs>(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setPrefs(saved), [saved.hideNativeAndStables, saved.hideSmall]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!supported) return null;
  const dirty = prefs.hideNativeAndStables !== saved.hideNativeAndStables || prefs.hideSmall !== saved.hideSmall;

  async function save() {
    setSaving(true);
    try {
      const next = { hideNativeAndStables: prefs.hideNativeAndStables, hideSmall: prefs.hideSmall };
      const auth = await signArenaWalletAction({
        action: "display_prefs_set",
        extraLines: [`Prefs: ${JSON.stringify(next)}`],
        walletAddress,
        chainId,
        evmWallet,
        solanaAccount,
      });
      const res = await apiFetch("/api/display-prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress, chainId, prefs: next, auth }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error || `Could not save (${res.status})`);
      client.setQueryData(displayPrefsKey(walletAddress), { supported: true, prefs: j?.prefs || next });
      toast.success("Portfolio settings saved");
    } catch (err: any) {
      const msg = String(err?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was saved." : msg || "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${cp.card} flex flex-col gap-3 p-4`} data-display-settings="true">
      <div>
        <span className={cp.title}>Portfolio display</span>
        <p className="m-0 mt-1 text-[13px] text-mw-muted">What your Command Center and public profile list. Total value always counts every holding.</p>
      </div>
      {OPTIONS.map((o) => {
        const on = prefs[o.key];
        return (
          <div key={o.key} className="flex items-center gap-3 border-t border-mw-border pt-3">
            <span className="min-w-0 flex-1">
              <b className="block text-sm text-mw-text">{o.label}</b>
              <span className="text-[13px] text-mw-muted">{o.detail}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={o.label}
              onClick={() => setPrefs((p) => ({ ...p, [o.key]: !p[o.key] }))}
              className={`mw-focus relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors ${on ? "border-mw-accent bg-mw-accent" : "border-mw-edge bg-mw-raised"}`}
            >
              <span className={`mw-dot absolute h-5 w-5 rounded-full bg-mw-text transition-all ${on ? "left-6" : "left-1"}`} />
            </button>
          </div>
        );
      })}
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="mw-focus inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50"
          >
            {saving ? "Waiting for signature..." : "Save portfolio settings"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
