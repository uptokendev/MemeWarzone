import { pool } from "../../../server/db.js";
import { requireDashboardAdmin } from "../../dashboard/_auth.js";
import { createAbuseAdminHandlers } from "./handlers.js";

const handlers = createAbuseAdminHandlers({
  pool,
  requireDashboardAdmin,
});

export default handlers.blockedCoins;
