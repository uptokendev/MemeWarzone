import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * Compatibility route for historical /battle/:id links.
 * The Battle Wall focused route is now the single canonical Battle surface.
 */
export default function BattleDetails() {
  const { id } = useParams();
  const location = useLocation();
  const battleId = encodeURIComponent(String(id || ""));
  return <Navigate to={`/warzone/battles/${battleId}${location.search}${location.hash}`} replace />;
}
