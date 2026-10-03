import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, ExternalLink, Image, Mail, Settings, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { EditProfileDialog } from "@/components/profile/EditProfileDialog";
import { UsernameSettingsRow } from "@/components/profile/UsernameSettingsRow";
import { SettingsBannerRow } from "@/components/profile/SettingsBannerRow";
import { NotificationSettingsCard } from "@/components/profile/NotificationSettingsCard";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { setArenaNotificationEmail } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { usePrepareNotificationCenter } from "@/hooks/usePrepareNotificationCenter";
import { bellAllowed, useNotificationPrefs } from "@/hooks/useNotificationPrefs";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { getActiveChainId, getChainLabel, isAllowedChainId } from "@/lib/chainConfig";
import { requestWalletChainSwitch } from "@/lib/launchpadReadiness";
import type { DraftNotification } from "@/lib/draftPromotion";

function formatNotificationDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Settings and, since CO-29 (founder 2026-10-03), the Notifications tab: the same component renders
 * one section or the other so the handlers and data loading stay in one place.
 */
export default function CommandCenterSettings({ section = "settings" }: { section?: "settings" | "notifications" } = {}) {
  const showSettings = section === "settings";
  const showNotifications = section === "notifications";
  const {
    walletAddress,
    chainId,
    walletChainId,
    profile,
    loadingProfile,
    displayName,
    avatarUrl,
    editOpen,
    setEditOpen,
    savingProfile,
    savingAvatar,
    awaitingWallet,
    avatarInputRef,
    handleEdit,
    handlePickAvatar,
    handleAvatarSelected,
    handleSaveProfile,
  } = useCommandCenterData();

  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const navigate = useNavigate();
  const [switchingChain, setSwitchingChain] = useState(false);
  const [arenaEmail, setArenaEmail] = useState("");
  const [arenaEmailStatus, setArenaEmailStatus] = useState<{ configured: boolean; verified: boolean; email?: string | null } | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);
  const {
    notifications: allNotifications,
    loading: loadingNotifications,
    markOneRead,
    markAllRead,
  } = usePrepareNotificationCenter(walletAddress, 20);
  // CO-5: same rule as the bell: a category whose bell toggle is off is not listed.
  const notificationPrefs = useNotificationPrefs(walletAddress);
  const notifications = allNotifications.filter((item) => bellAllowed(notificationPrefs, item.category || "coin"));
  const unreadCount = notifications.filter((item) => !item.read).length;

  const handleSwitchChain = async () => {
    if (!wallet.provider) {
      toast.error("Connect a wallet first.");
      return;
    }
    setSwitchingChain(true);
    const target = getActiveChainId(wallet.chainId);
    const targetLabel = getChainLabel(target) ?? `Chain ${target}`;
    try {
      await requestWalletChainSwitch(wallet.provider, target);
      toast.success(`Switched to ${targetLabel}.`);
    } catch (err: any) {
      const message = String(err?.message || err || "");
      if (/user rejected|user denied|4001/i.test(message)) {
        toast("Switch cancelled.");
      } else {
        toast.error(`We couldn’t switch networks automatically. Please switch to ${targetLabel} in your wallet and try again.`);
      }
    } finally {
      setSwitchingChain(false);
    }
  };

  const handleOpenNotification = async (notification: DraftNotification) => {
    await markOneRead(notification.id);
    navigate(notification.target);
  };

  async function handleSaveArenaEmail() {
    setSavingEmail(true);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_notification_email_set",
        extraLines: [],
        walletAddress,
        chainId: chainId || walletChainId,
        evmWallet: wallet,
        solanaAccount,
      });
      const json = await setArenaNotificationEmail({ walletAddress, chainId: chainId || walletChainId, email: arenaEmail, auth });
      setArenaEmailStatus({ configured: true, verified: Boolean(json.verified), email: json.email || arenaEmail });
      toast.success(json.verifyEmailSent ? "Check your inbox to verify this address." : json.verifyEmailSkipped ? "Email saved. Verification mail is not configured in this environment." : "Email saved.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not save email."));
    } finally {
      setSavingEmail(false);
    }
  }

  // UI redesign (artboard Settings): presentation only; every handler above is unchanged.
  const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const smallButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-body text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50";
  const primaryButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-3 font-mw-body text-sm font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02] disabled:opacity-50";
  const field = "flex min-h-11 items-center rounded-[10px] border border-[#2E353D] bg-mw-input px-3.5 text-[15px]";
  const kvRow = "flex min-h-[34px] flex-wrap items-center justify-between gap-2.5 border-b border-[#1E2329] py-1 text-sm";

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <h2 className="sr-only">{showNotifications ? "Notifications" : "Settings"}</h2>
      {showSettings ? (
      <>
      <CommandCenterCard title="Profile">
        <div className="flex flex-wrap items-center gap-3">
          <img src={avatarUrl} alt={displayName} className="h-16 w-16 rounded-full border border-mw-border object-cover" />
          <Button onClick={handlePickAvatar} className={smallButton} disabled={savingProfile || savingAvatar}>
            <Image className="h-4 w-4" aria-hidden="true" />
            {savingAvatar ? (awaitingWallet ? "Confirm wallet..." : "Uploading...") : "Change picture"}
          </Button>
          {/* CO-19 (founder, 2026-10-03): Edit profile is a Command Center tab now. */}
          <Link to={`/profile/${encodeURIComponent(walletAddress)}/command/edit-profile`} className={primaryButton}>
            <Settings className="h-4 w-4" aria-hidden="true" />
            Edit profile
          </Link>
        </div>

        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleAvatarSelected(file);
            event.currentTarget.value = "";
          }}
        />

        <EditProfileDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          initialUsername={profile?.displayName ?? ""}
          initialBio={profile?.bio ?? ""}
          saving={savingProfile}
          onSave={handleSaveProfile}
        />

        <div className="flex flex-col gap-1.5">
          <span className={lbl}>Display name</span>
          <div className={field}>{displayName}</div>
        </div>
        <UsernameSettingsRow wallet={walletAddress} />
        <SettingsBannerRow walletAddress={walletAddress} chainId={chainId} />
        <div className="flex flex-col gap-1.5">
          <span className={lbl}>Bio</span>
          <div className={`${field} min-h-[72px] py-3 text-mw-muted`}>{loadingProfile ? "Loading profile..." : profile?.bio ? profile.bio : "No public bio set yet."}</div>
        </div>
      </CommandCenterCard>

      <CommandCenterCard title="Wallets">
        <div className={kvRow}>
          <span className="flex items-center gap-2 text-mw-muted"><Wallet className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />Owner wallet</span>
          <span className="break-all text-right font-mw-mono">{walletAddress}</span>
        </div>
        <div className={kvRow}>
          <span className="flex items-center gap-2 text-mw-muted"><ShieldCheck className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />Chain</span>
          <span className="font-semibold">{getChainLabel(walletChainId) ?? "Not detected"}</span>
        </div>
        {walletChainId && !isAllowedChainId(walletChainId) ? (
          <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[#5A3416] bg-mw-accent-fill p-3 text-sm">
            <span className="flex-1">Unsupported network - switch your wallet to BNB Smart Chain to interact.</span>
            <Button size="sm" className={smallButton} disabled={switchingChain || !wallet.provider} onClick={handleSwitchChain}>
              {switchingChain ? "Switching..." : "Switch network"}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link to={`/profile/${encodeURIComponent(walletAddress)}`} className={smallButton}>
            Public profile
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link to="/create" className={smallButton}>Create coin</Link>
        </div>
      </CommandCenterCard>

      </>
      ) : null}

      {showNotifications && postGradFlags.arena ? (
        <CommandCenterCard title="Arena challenge email">
          <p className="m-0 flex items-center gap-2 text-sm text-mw-muted">
            <Mail className="h-4 w-4 shrink-0 text-mw-accent-soft" aria-hidden="true" />
            Challenges also show in Command Center Battles. Add an email if you want a copy when someone challenges your coin.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className={lbl}>Email</span>
            <input
              type="email"
              value={arenaEmail}
              onChange={(event) => setArenaEmail(event.target.value)}
              className="mw-focus h-11 w-full rounded-[10px] border border-[#2E353D] bg-mw-input px-3.5 text-[15px] tracking-normal text-mw-text placeholder:text-[#5C6670]"
              placeholder="you@example.com"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className={primaryButton} disabled={savingEmail || !arenaEmail.trim()} onClick={() => void handleSaveArenaEmail()}>
              {savingEmail ? "Saving..." : "Save and verify"}
            </Button>
            {arenaEmailStatus?.configured ? (
              <span className={`inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold ${arenaEmailStatus.verified ? "border-[#1F5133] text-[#6EE7A0]" : "border-mw-edge text-[#FFB27A]"}`}>
                {arenaEmailStatus.verified ? "Verified" : "Awaiting verification"}
              </span>
            ) : null}
          </div>
        </CommandCenterCard>
      ) : null}

      {/* CO-5 (founder, 2026-10-03): per-category bell and email toggles. */}
      {showNotifications ? (
      <NotificationSettingsCard
        walletAddress={walletAddress}
        chainId={chainId || walletChainId}
        evmWallet={wallet}
        solanaAccount={solanaAccount}
        emailVerified={Boolean(arenaEmailStatus?.verified)}
      />
      ) : null}

      {showNotifications ? (
      <div id="notifications" className="scroll-mt-24">
        <CommandCenterCard
          title="Notifications"
          action={
            <Button onClick={() => void markAllRead()} className={smallButton} disabled={!notifications.length || unreadCount === 0}>
              Mark all read{unreadCount ? ` (${unreadCount})` : ""}
            </Button>
          }
        >
          <p className="m-0 flex items-center gap-2 text-sm text-mw-muted">
            <Bell className="h-4 w-4 shrink-0 text-mw-accent-soft" aria-hidden="true" />
            Launch alerts, Prepare Mode updates, and community activity for this wallet.
          </p>
          {loadingNotifications && !notifications.length ? <div className="text-sm text-mw-muted">Loading notifications...</div> : null}
          {!loadingNotifications && notifications.length === 0 ? <div className="text-sm text-mw-muted">No notifications yet.</div> : null}
          <div className="flex flex-col">
            {notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => void handleOpenNotification(notification)}
                className="mw-focus flex min-h-12 w-full items-start gap-3 border-b border-[#1E2329] py-2.5 text-left last:border-b-0 hover:bg-[#171B20]"
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notification.read ? "bg-mw-edge" : "bg-mw-accent"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-col gap-0.5 md:flex-row md:items-center md:justify-between">
                    <span className="text-sm font-semibold">{notification.title}</span>
                    <span className="text-xs text-mw-muted">{formatNotificationDate(notification.createdAt)}</span>
                  </span>
                  <span className="mt-0.5 block text-sm text-mw-muted">{notification.body}</span>
                </span>
                <span className="hidden h-[22px] items-center rounded-full border border-mw-edge px-2 text-xs font-semibold text-mw-muted md:inline-flex">{notification.kind}</span>
              </button>
            ))}
          </div>
        </CommandCenterCard>
      </div>
      ) : null}
    </div>
  );
}
