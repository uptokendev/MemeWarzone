import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { isPostGradNavEnabled, warRoomEnabled } from "@/features/postgrad/config";
import { activeNavKey, activeWarzoneChild, buildMainNav, buildMobileTabs } from "@/lib/shellNav.mjs";

/** Home (the feed on `/`) is in the menu from phase 2 of the redesign (founder, 2026-10-02). */
export const HOME_FEED_READY = true;

export function useShellNav() {
  const location = useLocation();
  const flags = useMemo(
    () => ({ warzone: isPostGradNavEnabled(), warRoom: warRoomEnabled, imports: projectImportsEnabled, homeFeed: HOME_FEED_READY }),
    [],
  );
  const items = useMemo(() => buildMainNav(flags), [flags]);
  const tabs = useMemo(() => buildMobileTabs(flags), [flags]);
  return {
    flags,
    items,
    tabs,
    activeKey: activeNavKey(location.pathname, { homeFeed: flags.homeFeed }),
    activeChild: activeWarzoneChild(location.pathname),
  };
}
