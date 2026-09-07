import { badMethod, getQuery, json } from "../../server/http.js";
import { getGraduationQuoteAssetDetail, listGraduationQuoteAssets } from "../lib/quoteAssetCatalog.js";
import { decorateQuoteAsset, filterCreatorGraduationAssets } from "../lib/approvedQuoteCatalog.js";
import { getLaunchChainReadiness } from "../lib/launchChainReadiness.js";

export default async function graduationQuoteAssets(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const id = String(req.params?.id || "").trim();
    if (id) {
      const detail = await getGraduationQuoteAssetDetail(id);
      const detailReadiness = getLaunchChainReadiness(Number(detail?.item?.chainId || 0));
      if (!detailReadiness.creationReady) return json(res, 404, { ok: false, error: "Quote asset not available while chain creation is disabled", code: "CHAIN_CREATION_NOT_READY" });
      if (!detail?.item?.newGraduationEligible) {
        return json(res, 404, { ok: false, error: "Quote asset not eligible for new graduation", code: "QUOTE_ASSET_NOT_ELIGIBLE" });
      }
      return json(res, 200, {
        ok: true,
        ...detail,
        item: decorateQuoteAsset(detail.item),
        updatedAt: new Date().toISOString(),
      });
    }

    const q = getQuery(req);
    const chainId = String(q.chainId || "").trim();
    if (!chainId) return json(res, 400, { ok: false, error: "chainId is required", code: "CHAIN_ID_REQUIRED" });
    const launchReadiness = getLaunchChainReadiness(Number(chainId));
    if (!launchReadiness.creationReady) {
      return json(res, 200, { ok: true, chainId, authority: "server_runtime", eligibility: "new_graduation_only", creationReady: false, readinessReason: launchReadiness.reason, items: [], updatedAt: new Date().toISOString() });
    }
    const catalogItems = await listGraduationQuoteAssets({ chainId });
    const items = filterCreatorGraduationAssets(catalogItems, {
      category: q.category,
      provider: q.provider,
      search: q.search || q.q,
    });
    return json(res, 200, {
      ok: true,
      chainId,
      authority: "server",
      eligibility: "new_graduation_only",
      items,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[graduation/quote-assets]", error);
    return json(res, 503, {
      ok: false,
      error: "Graduation quote asset catalog unavailable",
      code: "QUOTE_ASSET_CATALOG_UNAVAILABLE",
    });
  }
}
