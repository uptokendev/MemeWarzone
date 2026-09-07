import { badMethod, getQuery, json } from "../../server/http.js";
import { getGraduationQuoteAssetDetail, listGraduationQuoteAssets } from "../lib/quoteAssetCatalog.js";
import { decorateQuoteAsset, filterCreatorGraduationAssets } from "../lib/approvedQuoteCatalog.js";

export default async function graduationQuoteAssets(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const id = String(req.params?.id || "").trim();
    if (id) {
      const detail = await getGraduationQuoteAssetDetail(id);
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
