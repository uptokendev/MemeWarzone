import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui-v2";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { fetchMyHandle, handleWalletKey } from "@/lib/handlesApi";
import { UsernameForm } from "./UsernameForm";

const laterKey = (key: string) => `mwz:username-later:${key}`;

/**
 * Asks a connected wallet without a username to pick one (founder, 2026-10-02). "Later" closes it
 * for this browser session; it comes back on the next connect. Never shows when the API has no
 * usernames yet.
 */
export function UsernamePrompt() {
  const address = useActiveFeedWallet().address ?? null;
  const key = handleWalletKey(address);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
    if (!key) return;
    try {
      if (sessionStorage.getItem(laterKey(key))) return;
    } catch {}
    let cancelled = false;
    fetchMyHandle(key)
      .then((r) => {
        if (!cancelled && r.supported && !r.handle) setOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);

  function later() {
    try {
      sessionStorage.setItem(laterKey(key), "1");
    } catch {}
    setOpen(false);
  }

  if (!key || !address) return null;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : later())}
      title="Pick your username"
      description="Your @username is how people tag you in posts. Without one, nobody can tag you."
    >
      <div data-username-prompt="true">
        <UsernameForm
          wallet={address}
          current={null}
          onSaved={(handle) => {
            setOpen(false);
            toast.success(`You are @${handle}`);
          }}
          secondary={
            <button type="button" onClick={later} className="mw-focus inline-flex min-h-11 items-center px-4 text-[15px] font-semibold text-mw-muted hover:text-mw-text">
              Later
            </button>
          }
        />
      </div>
    </Modal>
  );
}
