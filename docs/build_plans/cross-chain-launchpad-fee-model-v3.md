# Cross-Chain Launchpad Fee Model V3

Status: canonical launchpad economics for the current BNB, Solana and Robinhood correction program.

This document supersedes older fee-routing tables only where they omitted the 0.10% creator trading share. Existing recruiter, OG, Squad, Airdrop and finalize rules remain in force unless this document says otherwise.

## Trade fee

User-facing BUY and SELL remain exactly 2.00% of trade notional.

| Route profile | League | Creator | Recruiter | Squad / Airdrop | Protocol | Total |
|---|---:|---:|---:|---:|---:|---:|
| Standard linked | 0.75% | 0.10% | 0.25% | 0.05% Squad | 0.85% | 2.00% |
| OG linked | 0.75% | 0.10% | 0.30% | 0.05% Squad | 0.80% | 2.00% |
| Unlinked | 0.75% | 0.10% | 0.00% | 0.30% Airdrop | 0.85% | 2.00% |

League continues splitting 30% weekly / 70% monthly internally.

The OG uplift comes from Protocol. It does not increase the trader fee.

## Finalize fee

Creator 0.10% is BUY/SELL only. Finalize/graduation stays 2.00% without a second creator royalty:

| Route profile | Recruiter / Airdrop | Squad | Protocol | Total |
|---|---:|---:|---:|---:|
| Standard linked | 0.30% Recruiter | 0.05% | 1.65% | 2.00% |
| OG linked | 0.35% Recruiter | 0.05% | 1.60% | 2.00% |
| Unlinked | 0.35% Airdrop | 0.00% | 1.65% | 2.00% |

## Custody rules

- Creator trading fees are always isolated per campaign.
- Creator identity is loaded from the canonical campaign record or on-chain campaign account, never from client input.
- No live BUY or SELL may call an arbitrary creator wallet directly.
- Claims must pay only the creator bound to that campaign.
- Missing creator routing on a new generation must fail closed.

## Required parity vectors

Every chain implementation must prove the same economic result for:

- 1 native-unit trade
- 0.1 native-unit trade
- smallest economically valid trade
- rounding boundary trade
- Standard linked BUY and SELL
- OG linked BUY and SELL
- Unlinked BUY and SELL
- Finalize/graduation

## Release gate

No BNB deployment, Robinhood activation, Solana upgrade, or Arena fee UI merge is release-ready until the chain implementation, backend/indexer wiring, and shared Warzone fee UI all match this table exactly.
