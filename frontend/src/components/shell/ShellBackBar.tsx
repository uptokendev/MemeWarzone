import { useLocation } from "react-router-dom";
import { BackBar } from "@/components/ui-v2";
import { resolveBackBar } from "@/lib/shellNav.mjs";

/** Fixed under the top bar on routes that have no menu item. The shell adds its height to the page offset. */
export function ShellBackBar() {
  const location = useLocation();
  const back = resolveBackBar(location.pathname);
  if (!back) return null;
  return (
    <div className="fixed left-0 right-0 top-[var(--mw-topbar-h)] z-30 bg-mw-ground px-2 lg:left-[var(--mwz-left-sidebar-width)] lg:px-4">
      <BackBar title={back.title} fallback={back.fallback} />
    </div>
  );
}

export function useHasBackBar() {
  const location = useLocation();
  return resolveBackBar(location.pathname) != null;
}
