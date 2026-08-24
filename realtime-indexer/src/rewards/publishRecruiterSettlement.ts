// Compatibility shim: keep the original import path but route all callers
// through the schema-locked implementation used by production.
export { publishRecruiterSettlementBatchesV2 as publishRecruiterSettlementBatches } from "./publishRecruiterSettlementV2.js";
