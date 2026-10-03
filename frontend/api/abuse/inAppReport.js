import { pool } from "../../server/db.js";
import { createAbuseReporterHandlers } from "./handlers.js";

const handlers = createAbuseReporterHandlers({ pool });

export default handlers.inAppReport;
