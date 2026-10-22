// Help Center articles: wallets. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "which-wallets-are-supported",
    "q": "Which wallets can I use on MemeWarzone?",
    "a": [
      "Which wallet you need depends on the chain. BNB Chain and Robinhood Chain use EVM wallets. Solana uses Solana wallets.",
      "The connect window lists the wallets it finds in your browser. Wallets that are installed show first."
    ],
    "bullets": [
      "EVM (BNB Chain, Robinhood Chain): MetaMask, Rabby, Coinbase Wallet, Trust Wallet, OKX Wallet, Binance Wallet and other browser wallets, plus WalletConnect.",
      "Solana: Phantom, Solflare, Backpack and other Solana wallets that support wallet-standard."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "metamask",
      "phantom",
      "rabby",
      "solflare",
      "trust wallet",
      "okx",
      "coinbase wallet",
      "walletconnect",
      "ledger",
      "which wallet"
    ],
    "popular": true,
    "sources": [
      "frontend/src/components/wallet/ConnectWalletModal.tsx:82-96",
      "frontend/src/lib/injectedWallets.ts:11-24",
      "frontend/src/lib/walletConnect.ts:20",
      "docs-site/src/content/getting-started.md"
    ],
    "needsReview": "The list is what the connect window recognises. Any wallet that announces itself in the browser also appears, so the list is not exhaustive."
  },
  {
    "slug": "which-wallet-for-robinhood-chain",
    "q": "Which wallet do I need for Robinhood Chain?",
    "a": [
      "Any EVM wallet, such as MetaMask or Rabby. The same address you use on BNB Chain works on Robinhood Chain. You pay network fees in ETH.",
      "If Robinhood Chain is not in your wallet yet, MemeWarzone asks the wallet to add it when you pick the chain. Confirm the request in the wallet. A Solana wallet like Phantom cannot be used for Robinhood Chain coins."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "robinhood",
      "rh chain",
      "4663",
      "add network",
      "eth",
      "metamask robinhood"
    ],
    "alsoIn": [
      "getting-started"
    ],
    "sources": [
      "frontend/src/lib/chainConfig.ts:560-567",
      "docs-site/src/content/platform/chain-readiness.md"
    ]
  },
  {
    "slug": "robinhood-chain-rpc-update",
    "q": "Robinhood Chain shows errors in my wallet. Do I need to update the network?",
    "a": [
      "If you added Robinhood Chain to your wallet through MemeWarzone before October 14, it may use an old RPC address that now fails often. Balances and transactions can then error.",
      "When this applies to you, MemeWarzone shows an Update Robinhood Chain notice once per session. Press Update and confirm once in your wallet. You can also set the network's RPC to https://rpc.mainnet.chain.robinhood.com in the wallet's network settings."
    ],
    "keywords": [
      "rpc",
      "robinhood error",
      "balance not loading",
      "network settings",
      "failed rpc"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "frontend/src/components/wallet/RobinhoodWalletRpcNotice.tsx:1-58"
    ]
  },
  {
    "slug": "connect-phantom-wallet",
    "q": "How do I connect Phantom, and why can't I?",
    "a": [
      "Press Connect Wallet in the top right, pick Phantom and approve the request in the Phantom popup. Phantom is for Solana coins. For BNB Chain or Robinhood Chain use an EVM wallet.",
      "If nothing happens, work through the checks below."
    ],
    "steps": [
      "Unlock Phantom. A locked wallet cannot answer the request.",
      "Reload the page and try again. Allow popups for memewar.zone if your browser blocks them.",
      "Make sure Phantom is installed in the browser you are using. If you run several wallet extensions, disable the ones you do not need.",
      "On a phone, a normal mobile browser cannot reach wallet apps. Use Open in Phantom in the connect window, or open memewar.zone from the browser inside the Phantom app."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "phantom",
      "wallet not connecting",
      "cannot connect",
      "connect failed",
      "solflare",
      "popup",
      "not detected"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "popular": true,
    "sources": [
      "frontend/src/components/wallet/ConnectWalletModal.tsx:214-250",
      "frontend/src/lib/mobileWalletLinks.mjs:28-75"
    ]
  },
  {
    "slug": "connect-metamask-wallet",
    "q": "How do I connect MetaMask or another EVM wallet?",
    "a": [
      "Use an EVM wallet for BNB Chain and Robinhood Chain. The steps are the same for MetaMask, Rabby, Trust Wallet, Coinbase Wallet and OKX Wallet."
    ],
    "steps": [
      "Press Connect Wallet in the top right.",
      "Pick your wallet from the list. If you use WalletConnect, scan the code with your wallet app.",
      "Approve the connection in the wallet.",
      "Sign the one sign-in message when it appears. It is a signature, not a transaction.",
      "Pick BNB or Robinhood with the chain buttons. Your wallet may ask you to switch network."
    ],
    "keywords": [
      "metamask",
      "rabby",
      "trust wallet",
      "coinbase wallet",
      "okx",
      "evm wallet",
      "connect",
      "walletconnect"
    ],
    "sources": [
      "frontend/src/components/wallet/ConnectWalletModal.tsx:285-300",
      "frontend/src/components/wallet/WalletSignInGate.tsx:30-60"
    ]
  },
  {
    "slug": "connect-wallet-on-phone",
    "q": "How do I connect a wallet on my phone?",
    "a": [
      "Phone browsers cannot talk to wallet apps directly. When no wallet is found, the connect window shows Open this page in your wallet app. Tap your wallet and the page opens inside it, ready to connect.",
      "Phantom and Solflare (Solana) and MetaMask, Trust Wallet and OKX Wallet (EVM) have these links. If the app is not installed, the link sends you to its download page. For Binance Wallet, open memewar.zone from the Discover tab of the app."
    ],
    "keywords": [
      "mobile",
      "iphone",
      "android",
      "in-app browser",
      "dapp browser",
      "open in wallet"
    ],
    "sources": [
      "frontend/src/components/wallet/ConnectWalletModal.tsx:214-252",
      "frontend/src/lib/mobileWalletLinks.mjs:28-75"
    ]
  },
  {
    "slug": "why-sign-a-message-when-connecting",
    "q": "Why does MemeWarzone ask me to sign a message when I connect?",
    "a": [
      "The signature proves the wallet is yours. It is valid for 30 days. It is not a transaction, it costs no fee and it moves no funds.",
      "After you sign in, actions such as posting, following, voting, editing your profile and changing settings need no further prompt. Anything that moves money, deploys a coin or acts on-chain always asks your wallet again.",
      "If you decline, you can keep browsing. Those actions then ask for a signature each time you use them."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Your profile"
      }
    ],
    "keywords": [
      "signature",
      "sign in",
      "sign message",
      "30 days",
      "is it safe to sign",
      "gas free"
    ],
    "alsoIn": [
      "safety"
    ],
    "popular": true,
    "sources": [
      "frontend/src/components/wallet/WalletSignInGate.tsx:30-60",
      "frontend/src/lib/sessionActions.ts:1-40",
      "founder 2026-10-06"
    ]
  },
  {
    "slug": "how-to-switch-chains",
    "q": "How do I switch between BNB Chain, Solana and Robinhood Chain?",
    "a": [
      "Use the chain buttons (BNB, Solana, Robinhood) on Coins, Leagues or the War Room. Your choice is remembered, and Coins, Leagues, the Major War League, the War Room and search all follow it.",
      "A coin page always opens on the coin's own chain. The Battles list has its own chain filter, which can also show all chains at once."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Coins"
      },
      {
        "href": "/league",
        "text": "Leagues"
      }
    ],
    "keywords": [
      "change chain",
      "switch network",
      "chain selector",
      "bnb solana robinhood",
      "network"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:14-20"
    ]
  },
  {
    "slug": "switch-network-in-wallet",
    "q": "Why does my wallet ask me to switch networks?",
    "a": [
      "The action you started is on a different network from the one selected in your wallet. A BNB Chain coin needs your wallet on BNB Chain, and a Robinhood Chain coin needs it on Robinhood Chain.",
      "Approve the switch in your wallet. The same EVM address works on both chains, but the wallet has to be on the right network for the transaction. If your wallet is on a network MemeWarzone does not support, Settings in the Command Center shows a Switch network button."
    ],
    "keywords": [
      "wrong network",
      "unsupported network",
      "switch chain",
      "change network metamask",
      "chain mismatch"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "frontend/src/pages/command-center/CommandCenterSettings.tsx:167-176",
      "docs-site/src/content/platform/chain-readiness.md:39-48"
    ]
  },
  {
    "slug": "use-evm-and-solana-wallets-together",
    "q": "Can I connect a BNB wallet and a Solana wallet at the same time?",
    "a": [
      "Yes. Both can be connected from the same wallet window. Balances, coins and rewards stay separate per chain, and a Solana wallet does not change anything on your BNB Chain data.",
      "An EVM wallet and a Solana wallet have different addresses, so each has its own profile."
    ],
    "keywords": [
      "two wallets",
      "multiple wallets",
      "both wallets",
      "evm and solana",
      "combined balance"
    ],
    "sources": [
      "frontend/src/lib/helpCenter.ts:69-95",
      "frontend/src/components/wallet/ConnectWalletModal.tsx:285-320"
    ]
  },
  {
    "slug": "same-profile-on-every-chain",
    "q": "Is my profile the same on every chain?",
    "a": [
      "Yes, for one wallet address. Your picture, name, @username and bio belong to the address and show on every chain. Save them once under Edit profile in the Command Center.",
      "The same EVM address is used on BNB Chain and Robinhood Chain, so those share one profile. A Solana address is a different wallet, so it has its own profile."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Your profile"
      }
    ],
    "keywords": [
      "profile",
      "username",
      "one profile",
      "cross chain",
      "link wallets"
    ],
    "alsoIn": [
      "social"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:50-52",
      "docs-site/src/content/social/index.md"
    ],
    "needsReview": "Check whether a Solana wallet and an EVM wallet can be linked into one profile; this answer says they cannot."
  },
  {
    "slug": "disconnect-wallet",
    "q": "How do I disconnect my wallet?",
    "a": [
      "Click your wallet address in the top bar and press Disconnect wallet. This disconnects both an EVM and a Solana wallet if both are connected.",
      "MemeWarzone also drops the connection after 15 minutes without activity in the tab. Reconnecting is silent and needs no new approval in most wallets. To revoke the site's access completely, remove memewar.zone from the connected sites in your wallet."
    ],
    "keywords": [
      "log out",
      "logout",
      "sign out",
      "disconnect",
      "revoke",
      "connected sites"
    ],
    "sources": [
      "frontend/src/components/TopBar.tsx:314-340",
      "frontend/src/lib/idleSession.mjs:1-10"
    ]
  },
  {
    "slug": "wallet-disconnects-by-itself",
    "q": "Why was my wallet disconnected on its own?",
    "a": [
      "After 15 minutes without any activity in the tab, MemeWarzone drops the app's wallet connection to save resources. After 2 minutes of inactivity it also pauses live updates.",
      "Move the mouse or press a key and the app reconnects. Your wallet itself stays authorized, so reconnecting does not need a new approval."
    ],
    "keywords": [
      "idle",
      "timeout",
      "logged out",
      "reconnect",
      "session expired"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "frontend/src/lib/idleSession.mjs:1-10"
    ]
  },
  {
    "slug": "do-i-need-a-new-wallet-for-memewarzone",
    "q": "Should I use a separate wallet for MemeWarzone?",
    "a": [
      "You do not have to, but many people use a separate wallet for memecoins and keep their main funds elsewhere. Memecoins are risky, and a wallet that only holds what you are willing to lose limits the damage if something goes wrong.",
      "Whichever wallet you use, never share your seed phrase or private key with anyone. MemeWarzone never asks for them."
    ],
    "keywords": [
      "burner wallet",
      "new wallet",
      "safe wallet",
      "hot wallet",
      "seed phrase"
    ],
    "alsoIn": [
      "safety"
    ],
    "sources": [
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "which-coin-pays-for-gas",
    "q": "What do I need in my wallet to trade or launch?",
    "a": [
      "You need the chain's own coin for the trade amount and the network fee: BNB on BNB Chain, SOL on Solana and ETH on Robinhood Chain.",
      "Some Solana and Robinhood Chain coins are paired with another token, such as USDC or a stock token. The Buy panel shows what you pay in before you confirm."
    ],
    "keywords": [
      "gas",
      "bnb",
      "sol",
      "eth",
      "fees",
      "balance",
      "insufficient funds"
    ],
    "alsoIn": [
      "getting-started"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:24-36",
      "docs-site/src/content/creators/create-a-campaign.md"
    ]
  }
];
