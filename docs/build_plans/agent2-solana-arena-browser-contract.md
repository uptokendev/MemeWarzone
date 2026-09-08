# Agent 2 — Solana Arena browser contract

Authority: founder-locked PR #158 Arena handoff, 2026-09-04.

The browser remains wallet-custody-safe. It builds no authoritative Arena money state and never decides settlement/account truth from client-side Anchor account parsing. The backend verifies the confirmed transaction and exact PDA receipt before database/audit state becomes authoritative.

## Normal Battle paid Boost

1. `POST /api/arena/boosts/:battleId/solana-quote`
2. Browser constructs the instruction exactly from the returned `instruction` payload, signs it with the connected wallet, and sends it to Solana.
3. `POST /api/arena/boosts/:battleId/solana-payment` with the returned quote identity and transaction signature.

Do not call `/confirm` from the browser.

## Vote Tournament paid Boost

1. `POST /api/arena/tournaments/:tournamentId/matches/:matchRef/boosts/solana-quote`
2. Browser constructs the returned instruction, signs with the connected wallet, and sends it.
3. `POST /api/arena/tournaments/:tournamentId/matches/:matchRef/boosts/solana-payment` with quote identity and signature.

Vote Tournament paid Boost remains `$1 = 2 Vote Points`. It is available during regulation only and must be unavailable once Final Salvo begins.

Do not call `/confirm` from the browser.

## Event sponsorship

Browser-safe routes:

- `GET /api/arena/sponsorships/options`
- `GET /api/arena/sponsorships/:eventId/state`
- `GET /api/arena/sponsorships/payments/:quoteId`
- `POST /api/arena/sponsorships/solana-quote`
- `POST /api/arena/sponsorships/solana-payment`

`/api/arena/sponsorships/confirm` is internal-only.

Supported event categories only:

- Normal Tournament
- Vote Tournament
- Monthly MWL
- Quarterly Championship

Individual Battle sponsorship is not supported.

After Solana sponsorship payment, backend authority requires all of the following before DB/audit activation:

1. confirmed successful transaction;
2. exact `SponsorshipReceiptV1` PDA and payment/event/sponsor/70-20-10 fields;
3. authoritative `EventPrizeVaultV1` reread with exact event identity;
4. transaction-local vault lamport delta equal to the exact gross sponsorship payment;
5. prize/marketing/protocol contribution conservation at 70/20/10.

## Client authority boundary

Agent 2 may display backend-returned PDAs, quote amounts, receipt/payment status, and public event state. Agent 2 must not parse Anchor Arena money accounts in the browser to decide whether payment, Boost points, sponsorship, League routing, settlement, cancellation, refund, or claims are authoritative.
