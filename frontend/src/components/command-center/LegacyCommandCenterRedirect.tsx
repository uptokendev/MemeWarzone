import { Navigate, useLocation, useParams } from "react-router-dom";

import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { normalizeRouteWallet } from "@/lib/address";

type CommandCenterSection =
  | "overview"
  | "recruiter"
  | "squad"
  | "airdrops"
  | "claims"
  | "settings"
  | "followers"
  | "following"
  | "coins"
  | "battles"
  | "support"
  | "support/report"
  | "support/reports"
  | "support/reports/:reportId";

type LegacyCommandCenterRedirectProps = {
  section: CommandCenterSection;
};

export function LegacyCommandCenterRedirect({ section }: LegacyCommandCenterRedirectProps) {
  const evmWallet = useWallet();
  const feedWallet = useActiveFeedWallet();
  const location = useLocation();
  const { reportId = "" } = useParams();
  const accountWallet = normalizeRouteWallet(feedWallet.address || evmWallet.account);

  if (!accountWallet) {
    return <Navigate to="/profile" replace />;
  }

  const suffix = section === "overview"
    ? ""
    : section === "support/reports/:reportId" && reportId
      ? `/support/reports/${encodeURIComponent(reportId)}`
      : `/${section}`;
  return <Navigate to={`/profile/${accountWallet}/command${suffix}${location.search}${location.hash}`} replace />;
}
