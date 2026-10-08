// Example page for the swap widget: the coin comes from ?mint=, the API from ?api= (default live).
var params = new URLSearchParams(location.search);
MemeWarzoneSwap.mount("#mwz-swap", {
  mint: params.get("mint") || "",
  apiBase: params.get("api") || "https://api.memewar.zone",
  side: params.get("side") === "sell" ? "sell" : "buy",
});
