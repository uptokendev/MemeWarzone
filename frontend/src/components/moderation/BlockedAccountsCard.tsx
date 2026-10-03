import { toast } from "sonner";
import { Link } from "react-router-dom";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { useModeration } from "@/hooks/useModeration";

/** Settings: accounts you blocked, with Unblock (CO-30, founder 2026-10-03). */
export function BlockedAccountsCard() {
  const moderation = useModeration();
  if (!moderation.supported) return null;
  return (
    <CommandCenterCard title="Blocked accounts">
      <p className="m-0 text-sm text-mw-muted">Their posts and comments are hidden for you. Their coin pages and trading are not affected.</p>
      {moderation.blockedList.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-blocked-accounts="true">
          {moderation.blockedList.map((wallet) => (
            <li key={wallet} className="flex items-center gap-3 rounded-[10px] border border-mw-border bg-mw-input px-3 py-2">
              <Link to={`/profile/${encodeURIComponent(wallet)}`} className="min-w-0 flex-1 truncate font-mw-mono text-sm text-mw-text hover:text-mw-accent-soft">
                <WalletLabel wallet={wallet} />
              </Link>
              <button
                type="button"
                onClick={() =>
                  void moderation.unblock(wallet).then(
                    () => toast.success("Unblocked"),
                    (error) => toast.error(String((error as Error)?.message || "Could not unblock")),
                  )
                }
                className="mw-focus inline-flex min-h-10 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830]"
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-mw-muted">You have not blocked anyone.</p>
      )}
    </CommandCenterCard>
  );
}
