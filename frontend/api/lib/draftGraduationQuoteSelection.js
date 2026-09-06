export function catalogQuoteSelectionReference(item, draftChainId) {
  const id = String(item?.id || "").trim();
  if (!id) throw new Error("Graduation Market quote asset id is required.");
  if (item?.presentationDefault === true) {
    throw new Error("Graduation Market must be a catalog quote asset.");
  }
  if (item?.newGraduationEligible !== true) {
    throw new Error("Graduation Market is not eligible.");
  }
  const catalogChain = String(item.chainId ?? "").trim();
  const draftChain = String(draftChainId ?? "").trim();
  if (!draftChain || catalogChain !== draftChain) {
    throw new Error("Graduation Market does not match this draft chain.");
  }
  const policyVersion =
    item?.policy?.version != null && String(item.policy.version).trim() !== ""
      ? String(item.policy.version)
      : String(item?.policy?.policyKey || "").trim();
  if (!policyVersion) throw new Error("Graduation Market policy version is missing.");
  return {
    quoteAssetId: id,
    chainId: Number(draftChain),
    selectedStateVersion: Number(item.stateVersion || 0),
    policyVersion,
  };
}

export function isStaleOrDisabledCatalogQuote(item) {
  if (!item) return true;
  if (item.presentationDefault === true) return true;
  if (item.newGraduationEligible !== true) return true;
  const adminState = String(item.adminState || "").toLowerCase();
  if (adminState && adminState !== "enabled" && adminState !== "default") return true;
  return false;
}
