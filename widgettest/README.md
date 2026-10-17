# Widget test bench

Three swap boxes side by side for real test trades: our bonding curve (K88), bonding on Meteora DBC (DAZILLA)
and an imported coin (DERPYDAVE, Jupiter, 1% fee). Real wallet, real SOL: keep amounts tiny.

## Run it locally (uses the live widget and live API)

```bash
cd ~/mwz-wt/import-creator-fees/widgettest   # or the widgettest folder of any checkout
python3 -m http.server 8787
```

Open http://localhost:8787 in the browser that has Phantom (wallets do not run on file:// pages).

## Hidden page on the app

The same page is deployed, not linked anywhere and marked noindex: https://app.memewar.zone/widget/test.html

## Options (query string)

`?launchpad=<mint>&dbc=<mint>&import=<mint>` swaps the default coins, `&theme=light` uses the light box,
`&api=<url>` points at another API (for example the test API). The form at the bottom adds a box for any mint.

The page code is `frontend/public/widget/test.html` + `test.js`; this folder is a copy that loads the widget
from app.memewar.zone instead of the same site.
