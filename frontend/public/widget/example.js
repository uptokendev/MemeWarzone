// Example page for the swap widget: the coin comes from ?mint= (Solana) or ?chainId=&token= (Solana 101, BNB Chain 56,
// Robinhood Chain 4663), the API from ?api= (default live), a partner id from ?partner=.
var params = new URLSearchParams(location.search);
var options = {
  apiBase: params.get("api") || "https://api.memewar.zone",
  side: params.get("side") === "sell" ? "sell" : "buy",
};
if (params.get("mint")) {
  options.mint = params.get("mint");
} else if (params.get("token")) {
  options.chainId = Number(params.get("chainId") || 101);
  options.token = params.get("token");
} else {
  options.mint = "";
}
if (params.get("partner")) options.partner = params.get("partner");
MemeWarzoneSwap.mount("#mwz-swap", options);
