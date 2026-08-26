/**
 * Main Application Component
 * Handles routing, layout structure, and loading screen display
 * Sets up global providers for query client, tooltips, and toasts
 */

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
import WarRoom from "./pages/WarRoom";
import BattleDetails from "./pages/BattleDetails";
import ArenaTournaments from "./pages/ArenaTournaments";
import PostGradLeague from "./pages/PostGradLeague";
import League from "./pages/League";
import TournamentDetails from "./pages/TournamentDetails";
import Create from "./pages/Create";
import SponsorshipApplication from "./pages/SponsorshipApplication";
import ProfilePage from "./pages/ProfilePage";
import TokenDetailsEntry from "./pages/TokenDetailsEntry";
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
import { LeftBattleSidebar } from "@/components/LeftBattleSidebar";
import { RankPromotionListener } from "@/components/rank/RankPromotionListener";
import { LiveStreamOverlay } from "@/components/live/LiveStreamOverlay";
import { Footer } from "@/components/layout/Footer";
import { ScreenFrame } from "@/components/layout/ScreenFrame";
import { TokenSafetyRouteOverlay } from "@/components/token/TokenSafetyRouteOverlay";
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
import CommandCenterSocial from "@/pages/command-center/CommandCenterSocial";
import CommandCenterCoins from "@/pages/command-center/CommandCenterCoins";
import CommandCenterSupport from "@/pages/command-center/CommandCenterSupport";
import CommandCenterReportAbuse from "@/pages/command-center/CommandCenterReportAbuse";
import CommandCenterAbuseReports from "@/pages/command-center/CommandCenterAbuseReports";
import CommandCenterAbuseReportDetail from "@/pages/command-center/CommandCenterAbuseReportDetail";
import { isPostGradRouteEnabled, postGradFlags, warRoomEnabled } from "@/features/postgrad/config";
import { DocumentTitleSync } from "@/hooks/useDocumentTitle";
import { ProductAnalytics } from "@/lib/analytics/ProductAnalytics";

const queryClient = new QueryClient();

function LegacyTournamentRedirect() {
  const { id } = useParams();
  return <Navigate to={`/arena/tournament/${encodeURIComponent(String(id || ""))}`} replace />;
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
  const isShowcaseRoute = location.pathname === "/";
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

  const sidebarExpanded = 224;
  const sidebarCollapsed = 64;
  const currentSidebarWidth = leftSidebarCollapsed ? sidebarCollapsed : sidebarExpanded;
  const mainStyle = { "--mwz-left-sidebar-width": `${currentSidebarWidth}px` } as CSSProperties;

  return (
    <div
      className="mwz-app-shell flex h-screen flex-col overflow-x-hidden overflow-y-hidden"
      style={mainStyle}
    >
      <DocumentTitleSync />
      <ProductAnalytics />
      <OwnWalletRouteSync />
      <div className="hidden lg:block">
        <LeftBattleSidebar collapsed={leftSidebarCollapsed} onToggleCollapse={toggleLeftSidebar} />
      </div>

      <Sidebar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />
      <TopBar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} leftSidebarWidth={currentSidebarWidth} />
      <RankPromotionListener />
      <LiveStreamOverlay />
      <RewardUnlockFlight />
      <VictoryUnlockModal />
      <CreatorProtectionDialog />
      <CreatorArmEligibilityDialog />

      <main
        ref={mainRef}
        className={[
          "flex-1 overflow-x-hidden overflow-y-auto pb-10 md:pb-12 lg:pb-14 lg:pl-[calc(var(--mwz-left-sidebar-width)+0.75rem)]",
          isShowcaseRoute
            ? "scroll-pt-2 pt-2 md:scroll-pt-3 md:pt-3"
            : "scroll-pt-[4.5rem] pt-[4.5rem] [&>:first-child]:!pt-0",
        ].join(" ")}
      >
        <Routes>
          <Route path="/" element={<Showcase />} />
          {postGradEnabled && postGradFlags.arena ? <Route path="/arena" element={<Arena />} /> : null}
          {postGradEnabled && postGradFlags.battle ? <Route path="/arena/battles" element={<ArenaBattles />} /> : null}
          {postGradEnabled && postGradFlags.league ? <Route path="/arena/major-war-league" element={<PostGradLeague />} /> : null}
          {postGradEnabled && postGradFlags.league ? <Route path="/arena/leagues" element={<Navigate to="/arena/major-war-league" replace />} /> : null}
          {postGradEnabled && postGradFlags.tournament ? <Route path="/arena/tournaments" element={<ArenaTournaments />} /> : null}
          {postGradEnabled && postGradFlags.tournament ? <Route path="/arena/tournament/:id" element={<TournamentDetails />} /> : null}
          {postGradEnabled && postGradFlags.events ? <Route path="/arena/events" element={<Navigate to="/arena/tournaments" replace />} /> : null}
          {warRoomEnabled ? <Route path="/war-room" element={<WarRoom />} /> : null}
          {postGradEnabled && postGradFlags.battle ? <Route path="/battle/:id" element={<BattleDetails />} /> : null}
          <Route path="/sponsorships/apply" element={<SponsorshipApplication />} />
          {postGradEnabled && postGradFlags.events ? <Route path="/events" element={<Navigate to="/arena/tournaments" replace />} /> : null}
          <Route path="/league" element={<League />} />
          <Route path="/leagues" element={<Navigate to="/league" replace />} />
          {postGradEnabled && postGradFlags.tournament ? <Route path="/tournament/:id" element={<LegacyTournamentRedirect />} /> : null}
          <Route path="/create" element={<Create />} />
          <Route path="/drafts/:draftId/promotion" element={<DraftOwnerRoute><DraftPromotionSetup /></DraftOwnerRoute>} />
          <Route path="/drafts/:draftId/push-live" element={<DraftOwnerRoute><PushDraftLive /></DraftOwnerRoute>} />
          <Route path="/prepare/:slug" element={<Prepare />} />
          <Route path="/live" element={<Live />} />
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
          <Route path="/profile/:wallet/command/followers" element={<CommandCenterShell><CommandCenterSocial mode="followers" /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/following" element={<CommandCenterShell><CommandCenterSocial mode="following" /></CommandCenterShell>} />
          <Route path="/profile/:wallet/command/coins" element={<CommandCenterShell><CommandCenterCoins /></CommandCenterShell>} />
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
          <Route path="/token/:campaignAddress" element={<ScheduledTokenAccessRoute><TokenDetailsEntry /><TokenSafetyRouteOverlay /></ScheduledTokenAccessRoute>} />
          <Route path="/playbook" element={<Playbook />} />
          <Route path="/docs" element={<Playbook />} />
          <Route path="/status" element={<Status />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
      <ScreenFrame />
    </div>
  );
}

const App = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLoadComplete = () => {
    setIsLoading(false);
    setTimeout(() => setShowContent(true), 100);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <SolanaWalletProvider>
          <FeedChainWalletLatch />
          <TooltipProvider>
            <Toaster />
            <Sonner />
            {isLoading && <LoadingScreen onLoadComplete={handleLoadComplete} />}
            {showContent && (
              <BrowserRouter future={{ v7_relativeSplatPath: true }}>
                <AppShellLayout mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />
              </BrowserRouter>
            )}
          </TooltipProvider>
        </SolanaWalletProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
};

export default App;
