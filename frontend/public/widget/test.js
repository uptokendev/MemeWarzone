// Widget test bench (hidden): three swap boxes side by side for real test trades.
// Bonding on our curve (K88), bonding on Meteora DBC (DAZILLA) and an imported coin (DERPYDAVE).
// Real wallet, real transactions, real money: keep the amounts tiny.
(function () {
  var params = new URLSearchParams(location.search);
  var apiBase = params.get("api") || "https://api.memewar.zone";
  var theme = params.get("theme") === "light" ? "light" : "dark";
  var slots = [
    { id: "w-launchpad", title: "Our bonding curve (launchpad)", mint: params.get("launchpad") || "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77", note: "K88" },
    { id: "w-dbc", title: "Bonding on Meteora (DBC)", mint: params.get("dbc") || "6VJnmXSHkC7awLNqb684Metaxmj662noqH83CWCn8zih", note: "DAZILLA" },
    { id: "w-import", title: "Imported coin (Jupiter, 1%)", mint: params.get("import") || "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS", note: "DERPYDAVE" },
  ];
  var grid = document.getElementById("grid");
  var log = document.getElementById("log");

  function addLog(text, href) {
    var li = document.createElement("li");
    var time = new Date().toLocaleTimeString();
    if (href) {
      var a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
      li.appendChild(document.createTextNode(time + "  ")); li.appendChild(a);
    } else {
      li.textContent = time + "  " + text;
    }
    log.insertBefore(li, log.firstChild);
  }

  function mountSlot(slot) {
    var card = document.createElement("section");
    card.className = "card";
    card.innerHTML =
      '<h2></h2><p class="mint"></p><div class="mount" id="' + slot.id + '"></div>';
    card.querySelector("h2").textContent = slot.title;
    card.querySelector(".mint").textContent = slot.note + "  " + slot.mint;
    grid.appendChild(card);
    MemeWarzoneSwap.mount("#" + slot.id, {
      mint: slot.mint,
      apiBase: apiBase,
      theme: theme,
      onSwap: function (e) {
        addLog(slot.note + " " + e.side.toUpperCase() + " confirmed: " + e.signature.slice(0, 12) + "...", "https://solscan.io/tx/" + e.signature);
      },
    });
  }

  slots.forEach(mountSlot);

  document.getElementById("custom-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = document.getElementById("custom-mint");
    var mint = input.value.trim();
    if (!mint) return;
    var id = "w-custom-" + Date.now();
    mountSlot({ id: id, title: "Any mint", mint: mint, note: "custom" });
    input.value = "";
  });

  var wallet = (window.phantom && window.phantom.solana) || window.solflare || (window.backpack && window.backpack.solana) || window.solana;
  addLog(wallet ? "Solana wallet found in this browser." : "No Solana wallet found in this browser. Install Phantom, Solflare or Backpack.");
  addLog("API: " + apiBase);
})();
