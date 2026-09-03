import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, ExternalLink, Image, Mail, Settings, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { EditProfileDialog } from "@/components/profile/EditProfileDialog";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { setArenaNotificationEmail } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { usePrepareNotificationCenter } from "@/hooks/usePrepareNotificationCenter";
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

export default function CommandCenterSettings() {
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
    notifications,
    unreadCount,
    loading: loadingNotifications,
    markOneRead,
    markAllRead,
  } = usePrepareNotificationCenter(walletAddress, 20);

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

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <CommandCenterCard title="Profile settings">
          <div className="flex flex-col gap-4 rounded-2xl border border-border/50 bg-background/25 p-4 sm:flex-row sm:items-center">
            <img
              src={avatarUrl}
              alt={displayName}
              className="h-20 w-20 rounded-2xl border border-border/60 object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="font-retro text-lg text-foreground">{displayName}</div>
              <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{walletAddress}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={handleEdit} className="font-retro" disabled={savingProfile || savingAvatar}>
                  <Settings className="mr-2 h-4 w-4" />
                  Edit profile
                </Button>
                <Button onClick={handlePickAvatar} variant="outline" className="font-retro" disabled={savingProfile || savingAvatar}>
                  <Image className="mr-2 h-4 w-4" />
                  {savingAvatar ? (awaitingWallet ? "Confirm wallet..." : "Uploading...") : "Change avatar"}
                </Button>
              </div>
            </div>
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

          <div className="mt-4 rounded-2xl border border-border/50 bg-card/25 p-4 text-sm text-muted-foreground">
            {loadingProfile ? "Loading profile..." : profile?.bio ? profile.bio : "No public bio set yet."}
          </div>
        </CommandCenterCard>

        <CommandCenterCard title="Wallet / linked address">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-border/50 bg-background/25 p-4">
              <div className="mb-2 flex items-center gap-2 font-retro text-sm text-foreground">
                <Wallet className="h-4 w-4 text-accent" />
                Owner wallet
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">{walletAddress}</div>
            </div>
            <div className="rounded-2xl border border-border/50 bg-background/25 p-4">
              <div className="mb-2 flex items-center gap-2 font-retro text-sm text-foreground">
                <ShieldCheck className="h-4 w-4 text-accent" />
                Chain
              </div>
              <div className="font-retro text-sm text-muted-foreground">
                {getChainLabel(walletChainId) ?? "Not detected"}
              </div>
              {walletChainId && !isAllowedChainId(walletChainId) ? (
                <div className="mt-2 space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-amber-300">
                    Unsupported network - switch your wallet to BNB Smart Chain to interact.
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-retro"
                    disabled={switchingChain || !wallet.provider}
                    onClick={handleSwitchChain}
                  >
                    {switchingChain ? "Switching..." : "Switch network"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" className="font-retro">
              <Link to={`/profile/${encodeURIComponent(walletAddress)}`}>
                Public profile
                <ExternalLink className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="font-retro">
              <Link to="/create">Create coin</Link>
            </Button>
          </div>
        </CommandCenterCard>
      </div>

      {postGradFlags.arena ? (
        <CommandCenterCard title="Arena challenge email">
          <div className="rounded-2xl border border-border/50 bg-background/25 p-4">
            <div className="mb-2 flex items-center gap-2 font-retro text-sm text-foreground">
              <Mail className="h-4 w-4 text-accent" />
              Notify this wallet
            </div>
            <p className="text-sm text-muted-foreground">
              Challenges also show in Command Center Battles. Add an email if you want a copy when someone challenges your coin.
            </p>
            <label className="mt-3 block text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Email
              <input
                type="email"
                value={arenaEmail}
                onChange={(event) => setArenaEmail(event.target.value)}
                className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                placeholder="you@example.com"
              />
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" className="font-retro" disabled={savingEmail || !arenaEmail.trim()} onClick={() => void handleSaveArenaEmail()}>
                {savingEmail ? "Saving..." : "Save and verify"}
              </Button>
              {arenaEmailStatus?.configured ? (
                <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  {arenaEmailStatus.verified ? "Verified" : "Awaiting verification"}
                </span>
              ) : null}
            </div>
          </div>
        </CommandCenterCard>
      ) : null}

      <div id="notifications" className="scroll-mt-24">
        <CommandCenterCard title="Notifications">
          <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-background/25 p-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-accent" />
              <div>
                <div className="font-retro text-sm text-foreground">Profile notifications</div>
                <p className="text-sm text-muted-foreground">
                  Launch alerts, Prepare Mode updates, and community activity for this wallet.
                </p>
              </div>
            </div>
            <Button onClick={() => void markAllRead()} variant="outline" className="font-retro" disabled={!notifications.length || unreadCount === 0}>
              Mark all read{unreadCount ? ` (${unreadCount})` : ""}
            </Button>
          </div>

          <div className="mt-4 space-y-3">
            {loadingNotifications && !notifications.length ? (
              <div className="rounded-2xl border border-border/50 bg-background/25 p-4 text-sm text-muted-foreground">
                Loading notifications...
              </div>
            ) : null}

            {!loadingNotifications && notifications.length === 0 ? (
              <div className="rounded-2xl border border-border/50 bg-background/25 p-6 text-center text-sm text-muted-foreground">
                No notifications yet.
              </div>
            ) : null}

            {notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => void handleOpenNotification(notification)}
                className="flex w-full items-start gap-3 rounded-2xl border border-border/50 bg-background/25 p-4 text-left transition hover:border-accent/60 hover:bg-success/10"
              >
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 ${notification.read ? "bg-muted" : "bg-accent"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <span className="font-retro text-sm text-foreground">{notification.title}</span>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      {formatNotificationDate(notification.createdAt)}
                    </span>
                  </span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">{notification.body}</span>
                </span>
                <span className="hidden rounded-full border border-border/50 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground md:block">
                  {notification.kind}
                </span>
              </button>
            ))}
          </div>
        </CommandCenterCard>
      </div>
    </div>
  );
}
