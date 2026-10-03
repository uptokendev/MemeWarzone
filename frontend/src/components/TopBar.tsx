/**
 * Top Bar Component
 * Responsive header with search and actions
 */

import { bellAllowed, useNotificationPrefs } from "@/hooks/useNotificationPrefs";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Bell, Menu, Search } from "lucide-react";
import { SearchPopup } from "@/components/search/SearchPopup";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { warRoomEnabled } from "@/features/postgrad/config";
import { useWallet } from "@/contexts/WalletContext";
import { ConnectWalletModal } from "@/components/wallet/ConnectWalletModal";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveWalletKind } from "@/lib/activeWalletChain";

import { usePrepareNotificationCenter } from "@/hooks/usePrepareNotificationCenter";

interface TopBarProps {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
  leftSidebarWidth?: number; // from new collapsible left battle sidebar
}

type NavLinkItem = {
  label: string;
  path: string;
  priority: "primary" | "secondary";
};
const brandMark = "/images/mw.png";

function isExternalHref(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function navPathMatches(currentPathname: string, currentSearch: string, target: string): boolean {
  if (isExternalHref(target)) return false;

  try {
    const url = new URL(target, "https://memewarzone.local");
    if (url.pathname !== currentPathname) return false;
    for (const [key, value] of url.searchParams.entries()) {
      if (new URLSearchParams(currentSearch).get(key) !== value) return false;
    }
    return true;
  } catch {
    if (target === "/") return currentPathname === "/";
    return currentPathname.startsWith(target);
  }
}

export const TopBar = ({ mobileMenuOpen, setMobileMenuOpen, leftSidebarWidth = 0 }: TopBarProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const wallet = useWallet();
  const { solanaAccount, isSolanaConnected, disconnectSolana } = useSolanaWallet();
  // Last connected wallet owns the chrome. Opening a BNB Token Details URL must
  // not silently swap the TopBar to MetaMask while Phantom is the active session.
  const walletKind = getActiveWalletKind();
  const account =
    walletKind === "solana" && isSolanaConnected
      ? solanaAccount || wallet.account
      : walletKind === "bnb" && wallet.isConnected
        ? wallet.account
        : isSolanaConnected
          ? solanaAccount || wallet.account
          : wallet.account;
  const connected = wallet.isConnected || isSolanaConnected;
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const walletRef = useRef<HTMLButtonElement | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<{ top: number; right: number } | null>(null);
  const topbarStyle = { "--mwz-left-sidebar-width": `${leftSidebarWidth}px` } as CSSProperties;

  useEffect(() => {
    const updateAnchor = () => {
      const anchorEl = notificationOpen ? bellRef.current : disconnectOpen ? walletRef.current : null;
      if (!anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      setPopoverAnchor({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
    };
    updateAnchor();
    if (!notificationOpen && !disconnectOpen) return;
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [notificationOpen, disconnectOpen]);

  const {
    notifications: draftNotificationsAll,
    unreadCount: unreadNotificationsAll,
    markOneRead,
    markAllRead,
  } = usePrepareNotificationCenter(account, 20);
  // CO-5: draft and promotion notices are "your coin events"; hidden from the bell when that toggle is off.
  const coinBell = bellAllowed(useNotificationPrefs(account), "coin");
  const draftNotifications = coinBell ? draftNotificationsAll : [];
  const unreadNotifications = coinBell ? unreadNotificationsAll : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setNotificationOpen(false);
        setDisconnectOpen(false);
      } else if (e.key === "/" && !meta) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!notificationOpen && !disconnectOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-topbar-popover]")) return;
      setNotificationOpen(false);
      setDisconnectOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [notificationOpen, disconnectOpen]);

  const shortAddress = account && account.length > 8 ? `${account.slice(0, 4)}...${account.slice(-4)}` : account;

  const openWalletModal = () => {
    setWalletModalOpen(true);
  };

  const navLinks = useMemo<NavLinkItem[]>(
    () => [
      { label: "Launchpad", path: "/", priority: "primary" },
      ...(warRoomEnabled ? [{ label: "Trade War Room", path: "/war-room", priority: "primary" as const }] : []),
      { label: "Profile", path: "/profile?tab=balances", priority: "secondary" },
      { label: "Docs", path: "https://docs.memewar.zone", priority: "secondary" },
    ],
    []
  );

  const isActive = (path: string) => navPathMatches(location.pathname, location.search, path);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname, setMobileMenuOpen]);

  useEffect(() => {
    const onOpenWalletModal = () => setWalletModalOpen(true);
    window.addEventListener("memewarzone:openWalletModal", onOpenWalletModal as EventListener);
    return () => window.removeEventListener("memewarzone:openWalletModal", onOpenWalletModal as EventListener);
  }, []);

  const openNotificationTarget = async (notification: { id: string; target: string }) => {
    await markOneRead(notification.id);
    setNotificationOpen(false);
    navigate(notification.target);
  };

  const openNotificationSettings = () => {
    setNotificationOpen(false);
    if (account) {
      // CO-29: "View all" opens the Notifications tab, not the top of Settings.
      navigate(`/profile/${encodeURIComponent(account)}/command/notifications`);
      return;
    }
    navigate("/profile?tab=settings");
  };

  const iconButtonClass =
    "mw-focus relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-mw-text hover:bg-mw-raised";
  const popoverItemClass = "mw-focus w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-mw-muted hover:bg-mw-raised hover:text-mw-text";

  // top-[0px], not top-0: tactical-command-ui.css restyles every `.fixed.top-0` as the old
  // transparent HUD bar. z-[70] keeps the stacking that rule gave the bar before.
  return (
    <div
      data-mwz-topbar="true"
      className="fixed inset-x-0 top-[0px] z-[70] h-[var(--mw-topbar-h)] border-b border-[#1E2329] bg-mw-ground font-mw-body text-mw-text"
      style={topbarStyle}
    >
      <div className="flex h-full items-center gap-1 px-2 sm:gap-2 sm:px-3 lg:gap-5 lg:px-6">
        {/* Phones and tablets: the drawer holds the menu items the bottom bar has no room for. */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className={cn(iconButtonClass, "lg:hidden")}
          aria-label="Toggle menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>

        <Link
          to="/"
          aria-label="MemeWarzone home"
          className="mw-focus shrink-0 font-mw-brand text-[15px] tracking-[0.02em] text-mw-accent hover:text-mw-accent sm:text-[17px] lg:w-[188px] lg:text-xl"
        >
          MEMEWARZONE
        </Link>

        {/* Same search as before: opens the search palette (also on Ctrl/Cmd+K and "/"). */}
        <div className="hidden min-w-0 flex-1 lg:flex">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open search"
            className="mw-focus flex h-11 w-full max-w-[420px] items-center gap-2.5 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-left text-[15px] text-[#7C858F] hover:border-[#3A424C]"
          >
            <Search className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="flex-1 truncate">Search coins, creators, battles, or paste a CA</span>
            <kbd className="rounded border border-mw-edge px-1.5 font-mw-mono text-xs text-mw-muted">/</kbd>
          </button>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2 lg:ml-0">
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Open search" className={cn(iconButtonClass, "lg:hidden")}>
            <Search className="h-5 w-5" aria-hidden="true" />
          </button>

          {connected && (
            <div className="relative" data-topbar-popover>
              <button
                ref={bellRef}
                type="button"
                onClick={() => {
                  setDisconnectOpen(false);
                  setNotificationOpen((prev) => !prev);
                }}
                className={cn(iconButtonClass, "lg:border lg:border-mw-edge lg:bg-mw-raised")}
                aria-label={unreadNotifications > 0 ? `Notifications, ${unreadNotifications} unread` : "Notifications"}
              >
                <Bell className="h-5 w-5" aria-hidden="true" />
                {unreadNotifications > 0 && (
                  <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-mw-accent px-1 font-mw-mono text-[11px] font-bold text-[#140A02]">
                    {unreadNotifications}
                  </span>
                )}
              </button>

              {notificationOpen && popoverAnchor && createPortal(
                <div
                  data-topbar-popover
                  className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[14px] border border-mw-edge bg-mw-surface p-2 font-mw-body text-mw-text shadow-2xl"
                  style={{ position: "fixed", top: popoverAnchor.top, right: popoverAnchor.right, zIndex: 80 }}
                >
                  <div className="flex items-center justify-between gap-3 border-b border-mw-border px-2 pb-2">
                    <span className="font-mw-cond text-sm font-bold uppercase tracking-[0.08em]">Notifications</span>
                    <button type="button" onClick={() => void markAllRead()} className="mw-focus rounded px-1 text-xs font-semibold text-mw-muted hover:text-mw-text">
                      Mark read
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto py-1">
                    {draftNotifications.slice(0, 5).map((notification) => (
                      <button
                        key={notification.id}
                        type="button"
                        onClick={() => void openNotificationTarget(notification)}
                        className="mw-focus block w-full rounded-lg border-b border-mw-border/60 px-2 py-3 text-left hover:bg-mw-raised"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{notification.title}</span>
                          {!notification.read && <span className="h-2 w-2 shrink-0 rounded-full bg-mw-accent" aria-label="Unread" />}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-mw-muted">{notification.body}</p>
                      </button>
                    ))}
                    {draftNotifications.length === 0 && (
                      <div className="px-2 py-4 text-sm text-mw-muted">No notifications yet.</div>
                    )}
                  </div>
                  <button type="button" onClick={openNotificationSettings} className={cn(popoverItemClass, "mt-1 text-center")}>
                    View all
                  </button>
                </div>,
                document.body,
              )}
            </div>
          )}

          <div className="relative" data-topbar-popover>
            <button
              ref={walletRef}
              type="button"
              className="mw-focus inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] sm:px-4 sm:text-[15px]"
              onClick={() => {
                if (!connected) {
                  openWalletModal();
                  return;
                }
                setNotificationOpen(false);
                setDisconnectOpen((prev) => !prev);
              }}
            >
              <span className="hidden font-mw-mono text-[13px] sm:inline">{connected ? shortAddress : "Connect Wallet"}</span>
              <span className="sm:hidden">{connected ? "Wallet" : "Connect"}</span>
            </button>

            {disconnectOpen && popoverAnchor && createPortal(
              <div
                data-topbar-popover
                className="w-56 rounded-[14px] border border-mw-edge bg-mw-surface p-2 font-mw-body text-mw-text shadow-2xl"
                style={{ position: "fixed", top: popoverAnchor.top, right: popoverAnchor.right, zIndex: 80 }}
              >
                <div className="rounded-lg bg-mw-input px-3 py-2 font-mw-mono text-[13px]">
                  {shortAddress}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await Promise.all([
                        wallet.isConnected ? wallet.disconnect() : Promise.resolve(),
                        isSolanaConnected ? disconnectSolana() : Promise.resolve(),
                      ]);
                    } finally {
                      setDisconnectOpen(false);
                    }
                  }}
                  className={cn(popoverItemClass, "mt-2")}
                >
                  Disconnect wallet
                </button>
              </div>,
              document.body,
            )}
          </div>
        </div>
      </div>

      <SearchPopup open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ConnectWalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
    </div>
  );
};
