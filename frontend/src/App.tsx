/**
 * Main Application Component
 * Handles routing, layout structure, and loading screen display
 * Sets up global providers for query client, tooltips, and toasts
 */

import { CookieConsentBanner } from "@/components/consent/CookieConsentBanner";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Routes, Route, useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LoadingScreen } from "@/components/LoadingScreen";
import { WalletProvider } from "@/contexts/WalletContext";
import { SolanaWalletProvider } from "@/contexts/SolanaWalletContext";
import { FeedChainWalletLatch } from "@/components/common/ChainFeedSwitch";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { normalizeRouteWallet, routeWalletsMatch } from "@/lib/address";
import Showcase from "./pages/Showcase";
import Arena from "./pages/Arena";
import ArenaBattles from "./pages/ArenaBattles";
import BattlePage from "./pages/BattlePage";
import WarRoom from "./pages/WarRoom";
import BattleDetails from "./pages/BattleDetails";
import ArenaTournaments from "./pages/ArenaTournaments";
import PostGradLeague from "./pages/PostGradLeague";
import Feed from "./pages/Feed";
import PostThread from "./pages/PostThread";
import { HOME_FEED_READY } from "@/components/shell/useShellNav";
import { UsernamePrompt } from "@/components/profile/UsernamePrompt";
import League from "./pages/League";
import ArenaVerifyEmail from "./pages/ArenaVerifyEmail";
import Create from "./pages/Create";
import ProjectImport from "./pages/ProjectImport";
import SponsorshipApplication from "./pages/SponsorshipApplication";
import ProfilePage from "./pages/ProfilePage";
import TokenDetailsEntry from "./pages/TokenDetailsEntry";
import EmbedChartPage from "./pages/EmbedChartPage";
import StoryPage from "./pages/StoryPage";
import CoinEdit from "./pages/CoinEdit";
import { RouteErrorBoundary } from "@/components/app/RouteErrorBoundary";
import Playbook from "@/pages/Playbook";
import Prepare from "./pages/Prepare";
import Live from "./pages/Live";
import DraftPromotionSetup from "./pages/DraftPromotionSetup";
import PushDraftLive from "./pages/PushDraftLive";
import RecruiterLeaderboard from "./pages/RecruiterLeaderboard";
import Recruiter from "./pages/Recruiter";
import RecruiterProfile from "./pages/RecruiterProfile";
import RecruiterSignup from "./pages/RecruiterSignup";
import RecruiterReferral from "./pages/RecruiterReferral";
import AirdropOverview from "./pages/AirdropOverview";
import AirdropWinners from "./pages/AirdropWinners";
import SquadLeaderboard from "./pages/SquadLeaderboard";
import Status from "./pages/Status";
import NotFound from "./pages/NotFound";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { AppSideNav } from "@/components/shell/AppSideNav";
import { MobileTabBar } from "@/components/shell/MobileTabBar";
import { ShellBackBar, useHasBackBar } from "@/components/shell/ShellBackBar";
import { IncomingChallengeListener } from "@/components/arena/IncomingChallengeListener";
import { DbcScheduledLaunchListener } from "@/components/dbc/DbcScheduledLaunchListener";
import { RankPromotionListener } from "@/components/rank/RankPromotionListener";
import { LiveStreamOverlay } from "@/components/live/LiveStreamOverlay";
import { ScheduledTokenAccessRoute } from "@/components/token/ScheduledTokenAccessRoute";
import { CreatorProtectionDialog } from "@/components/token/CreatorProtectionDialog";
import { CreatorArmEligibilityDialog } from "@/components/prepare/CreatorArmEligibilityDialog";
import { CommandCenterShell } from "@/components/command-center/CommandCenterShell";
import { LegacyCommandCenterRedirect } from "@/components/command-center/LegacyCommandCenterRedirect";
import { ProfileWalletFallbackRedirect } from "@/components/command-center/ProfileWalletFallbackRedirect";
import { RewardUnlockFlight } from "@/components/profile/RewardUnlockFlight";
import { VictoryUnlockModal } from "@/components/profile/VictoryUnlockModal";
import { DraftOwnerRoute } from "@/components/prepare/DraftOwnerRoute";
import CommandCenterOverview from "@/pages/command-center/CommandCenterOverview";
import CommandCenterRecruiter from "@/pages/command-center/CommandCenterRecruiter";
import CommandCenterSquad from "@/pages/command-center/CommandCenterSquad";
import CommandCenterAirdrops from "@/pages/command-center/CommandCenterAirdrops";
import CommandCenterClaims from "@/pages/command-center/CommandCenterClaims";
import CommandCenterSettings from "@/pages/command-center/CommandCenterSettings";
import CommandCenterEditProfile from "@/pages/command-center/CommandCenterEditProfile";
import CommandCenterSocial from "@/pages/command-center/CommandCenterSocial";
import CommandCenterCoins from "@/pages/command-center/CommandCenterCoins";
import CommandCenterBattles from "@/pages/command-center/CommandCenterBattles";
import CommandCenterSupport from "@/pages/command-center/CommandCenterSupport";
import CommandCenterReportAbuse from "@/pages/command-center/CommandCenterReportAbuse";
import CommandCenterAbuseReports from "@/pages/command-center/CommandCenterAbuseReports";
import CommandCenterAbuseReportDetail from "@/pages/command-center/CommandCenterAbuseReportDetail";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { isPostGradRouteEnabled, postGradFlags, warRoomEnabled } from "@/features/postgrad/config";
import { DocumentTitleSync } from "@/hooks/useDocumentTitle";
import { ProductAnalytics } from "@/lib/analytics/ProductAnalytics";
import { isEmbedPath } from "@/lib/embedChart";

const queryClient = new QueryClient();

function LegacyTournamentRedirect() {
  const { id } = useParams();
  return <Navigate to={`/warzone/tournaments/${encodeURIComponent(String(id || ""))}`} replace />;
}

function ArenaToWarzoneRedirect() {
  const location = useLocation();
  const next = location.pathname.replace(/^\/arena/, "/warzone") || "/warzone";
  return <Navigate to={`${next}${location.search}${location.hash}`} replace />;
}

function OwnWalletRouteSync() {
  const navigate = useNavigate();
  const location = useLocation();
  const feedWallet = useActiveFeedWallet();
  const previousWalletRef = useRef<string | null>(null);
  const currentWallet = normalizeRouteWallet(feedWallet.address);

  useEffect(() => {
    const previousWallet = previousWalletRef.current;
    previousWalletRef.current = currentWallet;
    if (!previousWallet || !currentWallet || routeWalletsMatch(previousWallet, currentWallet)) return;

    const match = location.pathname.match(/^\/profile\/([^/]+)(\/command(?:\/.*)?)?$/);
    if (!match) return;
    let urlWallet = match[1];
    try {
      urlWallet = decodeURIComponent(match[1]);
    } catch {
      // keep raw
    }
    if (!routeWalletsMatch(urlWallet, previousWallet)) return;
    navigate(`/profile/${currentWallet}${match[2] || ""}${location.search}`, { replace: true });
  }, [currentWallet, location.pathname, location.search, navigate]);

  return null;
}

function AppShellLayout({
  mobileMenuOpen,
  setMobileMenuOpen,
}: {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
}) {
  const postGradEnabled = isPostGradRouteEnabled();
  const location = useLocation();
  const hasBackBar = useHasBackBar();
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
  }, [location.pathname, location.search]);

  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("mwz:left-sidebar-collapsed") === "true";
  });

  const toggleLeftSidebar = () => {
    const next = !leftSidebarCollapsed;
    setLeftSidebarCollapsed(next);
    try {
      localStorage.setItem("mwz:left-sidebar-collapsed", String(next));
    } catch {}
  };

  const sidebarExpanded = 236;
  const sidebarCollapsed = 72;
  const currentSidebarWidth = leftSidebarCollapsed ? sidebarCollapsed : sidebarExpanded;
  const mainStyle = { "--mwz-left-sidebar-width": `${currentSidebarWidth}px` } as CSSProperties;

  return (
    <div
      className="mwz-app-shell mw-shell flex h-screen flex-col overflow-x-hidden overflow-y-hidden"
      data-backbar={hasBackBar ? "true" : undefined}
      style={mainStyle}
    >
      <DocumentTitleSync />
      <ProductAnalytics />
      <OwnWalletRouteSync />
      <div className="hidden lg:block">
        <AppSideNav collapsed={leftSidebarCollapsed} onToggleCollapse={toggleLeftSidebar} />
      </div>

      <Sidebar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />
      <TopBar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} leftSidebarWidth={currentSidebarWidth} />
      <ShellBackBar />
      <MobileTabBar />
      <UsernamePrompt />
      <RankPromotionListener />
      <IncomingChallengeListener />
      <DbcScheduledLaunchListener />
      <LiveStreamOverlay />
      <RewardUnlockFlight />
      <VictoryUnlockModal />
      <CreatorProtectionDialog />
      <CreatorArmEligibilityDialog />
      <CookieConsentBanner />

      <main
        ref={mainRef}
        className={[
          "flex-1 overflow-x-hidden overflow-y-auto pb-[calc(var(--mwz-footer-offset)+1.25rem+env(safe-area-inset-bottom,0px))] lg:pl-[calc(var(--mwz-left-sidebar-width)+0.75rem)]",
          "scroll-pt-[var(--mwz-topbar-offset)] pt-[var(--mwz-topbar-offset)] [&>:first-child]:!pt-0",
        ].join(" ")}
      >
        <RouteErrorBoundary routeKey={location.pathname}>
        <Routes>
          {/* Home is the feed (founder D1, 2026-10-02; in the menu from phase 2 so the founder can follow it). */}
          <Route path="/" element={HOME_FEED_READY ? <Feed /> : <Showcase />} />
          <Route path="/coins" element={<Showcase />} />
          {postGradEnabled && postGradFlags.arena ? <Route path="/warzone" element={<Arena />} /> : null}
          {postGradEnabled && postGradFlags.arena ? <Route path="/warzone/verify-email" element={<ArenaVerifyEmail />} /> : null}
          {postGradEnabled && postGradFlags.battle ? <Route path="/warzone/battles" element={<ArenaBattles />} /> : null}
          {/* Dedicated battle page (UI redesign phase 4b, founder-approved); the list stays on /warzone/battles. */}
          {postGradEnabled && postGradFlags.battle ? <Route path="/warzone/battles/:battleId" element={<BattlePage />} /> : null}
          {postGradEnabled && postGradFlags.league ? <Route path="/warzone/major-war-league" element={<PostGradLeague />} /> : null}
          {postGradEnabled && postGradFlags.league ? <Route path="/warzone/leagues" element={<Navigate to="/warzone/major-war-league" replace />} /> : null}
          {postGradEnabled && postGradFlags.tournament ? <Route path="/warzone/tournaments" element={<ArenaTournaments />} /> : null}
          {postGradEnabled && postGradFlags.tournament ? <Route path="/warzone/tournaments/:tournamentId" element={<ArenaTournaments />} /> : null}
          {postGradEnabled && postGradFlags.tournament ? <Route path="/warzone/tournament/:id" element={<LegacyTournamentRedirect />} /> : null}
          {postGradEnabled && postGradFlags.events ? <Route path="/warzone/events" element={<Navigate to="/warzone/tournaments" replace />} /> : null}
          {postGradEnabled && postGradFlags.arena ? <Route path="/arena" element={<Navigate to="/warzone" replace />} /> : null}
          {postGradEnabled && postGradFlags.arena ? <Route path="/arena/*" element={<ArenaToWarzoneRedirect />} /> : null}
          {warRoomEnabled ? <Route path="/war-room" element={<WarRoom />} /> : null}
          {postGradEnabled && postGradFlags.battle ? <Route path="/battle/:id" element={<BattleDetails />} /> : null}
          <Route path="/sponsorships/apply" element={<SponsorshipApplication />} />
          {postGradEnabled && postGradFlags.events ? <Route path="/events" element={<Navigate to="/warzone/tournaments" replace />} /> : null}
          <Route path="/league" element={<League />} />
          <Route path="/leagues" element={<Navigate to="/league" replace />} />
          {postGradEnabled && postGradFlags.tournament ? <Route path="/tournament/:id" element={<LegacyTournamentRedirect />} /> : null}
          <Route path="/create" element={<Create />} />
          {projectImportsEnabled ? <Route path="/import" element={<ProjectImport />} /> : null}
          <Route path="/drafts/:draftId/promotion" element={<DraftOwnerRoute><DraftPromotionSetup /></DraftOwnerRoute>} />
          <Route path="/drafts/:draftId/push-live" element={<DraftOwnerRoute><PushDraftLive /></DraftOwnerRoute>} />
          <Route path="/prepare/:slug" element={<Prepare />} />
          <Route path="/live" element={<Live />} />
          {/* The feed lives on "/" (Home). */}
          <Route path="/feed" element={<Navigate to="/" replace />} />
          <Route path="/post/:postId" element={<PostThread />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/command" element={<LegacyCommandCenterRedirect section="overview" />} />
          <Route path="/command/overview" element={<LegacyCommandCenterRedirect section="overview" />} />
          <Route path="/command/recruiter" element={<LegacyCommandCenterRedirect section="recruiter" />} />
          <Route path="/command/squad" element={<LegacyCommandCenterRedirect section="squad" />} />
          <Route path="/command/airdrops" element={<LegacyCommandCenterRedirect section="airdrops" />} />
          <Route path="/command/claims" element={<LegacyCommandCenterRedirect section="claims" />} />
          <Route path="/command/settings" element={<LegacyCommandCenterRedirect section="settings" />} />
          <Route path="/command/followers" element={<LegacyCommandCenterRedirect section="followers" />} />
          <Route path="/command/following" element={<LegacyCommandCenterRedirect section="following" />} />
          <Route path="/command/coins" element={<LegacyCommandCenterRedirect section="coins" />} />
          <Route path="/command/feed" element={<Navigate to="/" replace />} />
          <Route path="/command/battles" element={<LegacyCommandCenterRedirect section="battles" />} />
          <Route path="/command/support" element={<LegacyCommandCenterRedirect section="support" />} />
          <Route path="/command/support/report" element={<LegacyCommandCenterRedirect section="support/report" />} />
          <Route path="/command/support/reports" element={<LegacyCommandCenterRedirect section="support/reports" />} />
          <Route path="/command/support/reports/:reportId" element={<LegacyCommandCenterRedirect section="support/reports/:reportId" />} />
          <Route path="/command/*" element={<LegacyCommandCenterRedirect section="overview" />} />
          <Route path="/profile/:wallet/command" element={<CommandCenterShell><CommandCenterOverview /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/overview" element={<CommandCenterShell><CommandCenterOverview /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/recruiter" element={<CommandCenterShell><CommandCenterRecruiter /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/squad" element={<CommandCenterShell><CommandCenterSquad /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/airdrops" element={<CommandCenterShell><CommandCenterAirdrops /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/claims" element={<CommandCenterShell><CommandCenterClaims /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/settings" element={<CommandCenterShell><CommandCenterSettings /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/edit-profile" element={<CommandCenterShell><CommandCenterEditProfile /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/notifications" element={<CommandCenterShell><CommandCenterSettings section="notifications" /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/followers" element={<CommandCenterShell><CommandCenterSocial mode="followers" /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/following" element={<CommandCenterShell><CommandCenterSocial mode="following" /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/coins" element={<CommandCenterShell><CommandCenterCoins /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/feed" element={<Navigate to="/" replace />} />
          <Route path="/profile/:wallet/command/battles" element={<CommandCenterShell><CommandCenterBattles /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/support" element={<CommandCenterShell><CommandCenterSupport /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/support/report" element={<CommandCenterShell><CommandCenterReportAbuse /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/support/reports/:reportId" element={<CommandCenterShell><CommandCenterAbuseReportDetail /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/support/reports" element={<CommandCenterShell><CommandCenterAbuseReports /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/*" element={<CommandCenterShell><CommandCenterOverview /></CommandCenterShell>} />
          <Route path="/profile/:identifier" element={<ProfilePage />} />
          <Route path="/profile/:wallet/*" element={<ProfileWalletFallbackRedirect />} />
          <Route path="/airdrops" element={<AirdropOverview />} />
          <Route path="/airdrops/winners" element={<AirdropWinners />} />
          <Route path="/recruiter" element={<Recruiter />} />
          <Route path="/recruiter/signup" element={<RecruiterSignup />} />
          <Route path="/recruiters" element={<RecruiterLeaderboard />} />
          <Route path="/recruiters/:code" element={<RecruiterProfile />} />
          <Route path="/recruiter-dashboard" element={<LegacyCommandCenterRedirect section="recruiter" />} />
          <Route path="/squads" element={<SquadLeaderboard />} />
          <Route path="/squad-dashboard" element={<LegacyCommandCenterRedirect section="squad" />} />
          <Route path="/r/:code" element={<RecruiterReferral />} />
          <Route path="/token/:campaignAddress" element={<ScheduledTokenAccessRoute><TokenDetailsEntry /></ScheduledTokenAccessRoute>} />
          {/* Owner-only coin page editor (UI redesign phase 1b). */}
          <Route path="/token/:campaignAddress/edit" element={<CoinEdit />} />
          <Route path="/story/:chainId/:token" element={<StoryPage />} />
          <Route path="/playbook" element={<Playbook />} />
          <Route path="/docs" element={<Playbook />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}

function EmbedAppShell() {
  return (
    <TooltipProvider>
      <DocumentTitleSync />
      <Routes>
        <Route path="/embed/chart/:chainId/:token" element={<EmbedChartPage />} />
        <Route
          path="/embed/*"
          element={
            <div className="flex h-screen w-screen items-center justify-center bg-black px-4 text-center text-xs text-muted-foreground">
              Unknown token.
            </div>
          }
        />
      </Routes>
    </TooltipProvider>
  );
}

function AppRoot() {
  const location = useLocation();
  const [isLoading, setIsLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLoadComplete = () => {
    setIsLoading(false);
    setTimeout(() => setShowContent(true), 100);
  };

  if (isEmbedPath(location.pathname)) {
    return <EmbedAppShell />;
  }

  return (
    <WalletProvider>
      <SolanaWalletProvider>
        <FeedChainWalletLatch />
        <TooltipProvider>
          <Toaster />
          <Sonner />
          {isLoading && <LoadingScreen onLoadComplete={handleLoadComplete} />}
          {showContent && (
            <AppShellLayout mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />
          )}
        </TooltipProvider>
      </SolanaWalletProvider>
    </WalletProvider>
  );
}

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_relativeSplatPath: true }}>
        <AppRoot />
      </BrowserRouter>
    </QueryClientProvider>
  );
};

export default App;
