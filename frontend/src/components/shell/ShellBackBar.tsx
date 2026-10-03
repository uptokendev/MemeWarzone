import { useLocation } from "react-router-dom";
import { BackBar } from "@/components/ui-v2";
import { resolveBackBar } from "@/lib/shellNav.mjs";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";

/** Fixed under the top bar on routes that have no menu item. The shell adds its height to the page offset. */
export function ShellBackBar() {
  const location = useLocation();
  const ownWallet = useActiveFeedWallet().address ?? null;
  const back = resolveBackBar(location.pathname, { ownWallet });
  if (!back) return null;
  return (
    <div className="fixed left-0 right-0 top-[var(--mw-topbar-h)] z-30 bg-mw-ground px-3 lg:left-[var(--mwz-left-sidebar-width)] lg:px-4">
      <BackBar title={back.title} fallback={back.fallback} />
    </div>
  );
}

export function useHasBackBar() {
  const location = useLocation();
  const ownWallet = useActiveFeedWallet().address ?? null;
  return resolveBackBar(location.pathname, { ownWallet }) != null;
}
