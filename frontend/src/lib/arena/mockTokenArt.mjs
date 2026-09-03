export const MOCK_TOKEN_ART = {
  GAP: "/assets/tokens/gap.jpg",
  GAPE: "/assets/tokens/gap.jpg",
  MOP: "/assets/tokens/mop.jpg",
  MOPS: "/assets/tokens/mop.jpg",
  RAT: "/assets/tokens/rat.jpg",
  RATS: "/assets/tokens/rat.jpg",
  SDO: "/assets/tokens/sdo.jpg",
  SDOGE: "/assets/tokens/sdo.jpg",
};

export function mockTokenArtForTicker(symbol) {
  const key = String(symbol || "").replace(/^\$/, "").trim().toUpperCase();
  return MOCK_TOKEN_ART[key] || null;
}
