import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/apiBase";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { cp } from "@/components/token/coinPageStyles";

/** Same categories, channels and order as api/lib/notificationPrefs.js (the signed line must match). */
const CATEGORIES = [
  { key: "battles", label: "Battle challenges", detail: "Someone challenges your coin, declines or counters." },
  { key: "social", label: "Replies, reposts, quotes, rockets and @mentions", detail: "Activity on your posts and when someone tags you." },
  { key: "rewards", label: "Rewards ready to claim", detail: "League, airdrop, recruiter and battle payouts." },
  { key: "coin", label: "Your coin events", detail: "Drafts, launch, graduation and big moments for coins you created." },
] as const;
type Category = (typeof CATEGORIES)[number]["key"];
type Prefs = Record<Category, { bell: boolean; email: boolean }>;

function clean(p: Partial<Prefs> | null | undefined): Prefs {
  const out = {} as Prefs;
  for (const c of CATEGORIES) {
    const row = (p?.[c.key] || {}) as { bell?: boolean; email?: boolean };
    out[c.key] = { bell: row.bell === false ? false : true, email: row.email === false ? false : true };
  }
  return out;
}

export function NotificationSettingsCard({
  walletAddress,
  chainId,
  evmWallet,
  solanaAccount,
  emailVerified,
}: {
  walletAddress: string;
  chainId?: number | null;
  evmWallet: any;
  solanaAccount?: string | null;
  emailVerified: boolean;
}) {
  const [supported, setSupported] = useState(false);
  const [saved, setSaved] = useState<Prefs>(clean(null));
  const [prefs, setPrefs] = useState<Prefs>(clean(null));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    apiFetch(`/api/notification-prefs?wallet=${encodeURIComponent(walletAddress)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setSupported(j.supported === true);
        const p = clean(j.prefs);
        setSaved(p);
        setPrefs(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  if (!supported) return null;
  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved);

  async function save() {
    setSaving(true);
    try {
      const next = clean(prefs);
      const auth = await signArenaWalletAction({
        action: "notification_prefs_set",
        extraLines: [`Prefs: ${JSON.stringify(next)}`],
        walletAddress,
        chainId,
        evmWallet,
        solanaAccount,
      });
      const res = await apiFetch("/api/notification-prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress, chainId, prefs: next, auth }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error || `Could not save (${res.status})`);
      setSaved(clean(j?.prefs));
      setPrefs(clean(j?.prefs));
      toast.success("Notification settings saved");
    } catch (err: any) {
      const msg = String(err?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was saved." : msg || "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const toggle = (on: boolean, onChange: () => void, label: string, disabled = false) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`mw-focus relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${on ? "border-mw-accent bg-mw-accent" : "border-mw-edge bg-mw-raised"}`}
    >
      <span className={`mw-dot absolute h-5 w-5 rounded-full bg-mw-text transition-all ${on ? "left-6" : "left-1"}`} />
    </button>
  );

  return (
    <section className={`${cp.card} flex flex-col gap-3 p-4`} data-notification-settings="true">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cp.title}>Notification settings</span>
        <span className="flex gap-6 pr-1 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
          <span className="w-12 text-center">Bell</span>
          <span className="w-12 text-center">Email</span>
        </span>
      </div>
      {CATEGORIES.map((c) => (
        <div key={c.key} className="flex items-center gap-3 border-t border-mw-border pt-3">
          <span className="min-w-0 flex-1">
            <b className="block text-sm text-mw-text">{c.label}</b>
            <span className="text-[13px] text-mw-muted">{c.detail}</span>
          </span>
          <span className="flex gap-6">
            {toggle(prefs[c.key].bell, () => setPrefs((p) => ({ ...p, [c.key]: { ...p[c.key], bell: !p[c.key].bell } })), `${c.label} in the bell`)}
            {toggle(prefs[c.key].email, () => setPrefs((p) => ({ ...p, [c.key]: { ...p[c.key], email: !p[c.key].email } })), `${c.label} by email`, !emailVerified)}
          </span>
        </div>
      ))}
      {!emailVerified ? <p className="m-0 text-xs text-mw-muted">Verify an email address above to get notifications by email.</p> : null}
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="mw-focus inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50"
          >
            {saving ? "Waiting for signature..." : "Save notification settings"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
