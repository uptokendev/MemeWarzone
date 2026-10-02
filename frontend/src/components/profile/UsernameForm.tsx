import { useEffect, useState } from "react";
import { cp } from "@/components/token/coinPageStyles";
import { useWallet } from "@/contexts/WalletContext";
import { HANDLE_COOLDOWN_DAYS, HANDLE_RE, checkHandle, saveHandle, type HandleCheck } from "@/lib/handlesApi";

function formatDate(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function statusLine(value: string, current: string | null, check: HandleCheck | null, checking: boolean) {
  if (!value) return { tone: "muted", text: "3 to 20 characters: letters, numbers and _." };
  if (!HANDLE_RE.test(value)) return { tone: "bad", text: "3 to 20 characters: letters, numbers and _." };
  if (current && value.toLowerCase() === current.toLowerCase() && value === current) return { tone: "muted", text: "This is your username." };
  if (checking || !check) return { tone: "muted", text: "Checking…" };
  if (check.available) return { tone: "good", text: `@${value} is available.` };
  if (check.reason === "taken") return { tone: "bad", text: `@${value} is taken.` };
  if (check.reason === "reserved") return { tone: "bad", text: `@${value} is reserved.` };
  if (check.reason === "cooldown") return { tone: "bad", text: `You can change your username again on ${formatDate(check.nextChangeAt)}.` };
  return { tone: "bad", text: "Usernames are not available right now." };
}

/** Username input with a live availability check and a signed save. Used by the connect popup and Settings. */
export function UsernameForm({
  wallet,
  current,
  onSaved,
  submitLabel = "Save username",
  secondary,
}: {
  wallet: string;
  current: string | null;
  onSaved: (handle: string) => void;
  submitLabel?: string;
  secondary?: React.ReactNode;
}) {
  const evm = useWallet() as any;
  const [value, setValue] = useState(current || "");
  const [check, setCheck] = useState<HandleCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setCheck(null);
    setError("");
    if (!HANDLE_RE.test(value)) return;
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(() => {
      checkHandle(value, wallet)
        .then((r) => {
          if (!cancelled) setCheck(r);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value, wallet]);

  const unchanged = Boolean(current) && value === current;
  const canSave = HANDLE_RE.test(value) && !unchanged && Boolean(check?.available) && !checking && !saving;
  const status = statusLine(value, current, check, checking);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      const { handle } = await saveHandle({ wallet, handle: value, evmSigner: evm?.signer ?? null });
      onSaved(handle);
    } catch (err: any) {
      const msg = String(err?.message || err || "");
      setError(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was saved." : msg || "Could not save username.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-username-form="true">
      <label className="flex flex-col gap-1.5">
        <span className={cp.label}>Username</span>
        <span className="flex h-12 items-center rounded-[10px] border border-mw-edge bg-mw-input px-3 focus-within:ring-2 focus-within:ring-mw-accent">
          <span className="font-mw-mono text-lg text-mw-muted">@</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20))}
            maxLength={20}
            autoComplete="off"
            spellCheck={false}
            placeholder="yourname"
            aria-describedby="username-status"
            className="h-full min-w-0 flex-1 bg-transparent pl-1 font-mw-mono text-lg text-mw-text placeholder:text-[#4B535C] focus:outline-none"
          />
        </span>
      </label>
      <p
        id="username-status"
        aria-live="polite"
        className={`m-0 text-sm ${status.tone === "good" ? "text-[#6EE7A0]" : status.tone === "bad" ? "text-mw-sell" : "text-mw-muted"}`}
      >
        {status.text}
      </p>
      {error ? <p className="m-0 text-sm text-mw-sell" role="alert">{error}</p> : null}
      <p className="m-0 text-xs text-mw-muted">
        Saving asks your wallet to sign a message. No transaction, no fee. You can change it once every {HANDLE_COOLDOWN_DAYS} days.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {secondary}
        <button
          type="submit"
          disabled={!canSave}
          className="mw-focus inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Waiting for signature…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
