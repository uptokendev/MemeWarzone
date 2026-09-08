from pathlib import Path

path = Path("frontend/src/pages/command-center/CommandCenterClaims.tsx")
text = path.read_text()
old = '''                await recordLeagueClaimTx({
                  chainId: claimChainId,
                  period: metadata.period,
                  epochStart: metadata.epochStart,
                  category: metadata.category,
                  rank: metadata.rank,
                  recipient: walletAddress,
                  nonce,
                  signature,
                  txHash,
                });
'''
new = '''                const recordNonce = await requestNonce(claimChainId, walletAddress);
                const recordMessage = buildLeagueClaimMessage({
                  chainId: claimChainId,
                  recipient: walletAddress,
                  period: metadata.period,
                  epochStart: metadata.epochStart,
                  category: metadata.category,
                  rank: metadata.rank,
                  nonce: recordNonce,
                });
                const recordSignature = await wallet.signer.signMessage(recordMessage);
                await recordLeagueClaimTx({
                  chainId: claimChainId,
                  period: metadata.period,
                  epochStart: metadata.epochStart,
                  category: metadata.category,
                  rank: metadata.rank,
                  recipient: walletAddress,
                  nonce: recordNonce,
                  signature: recordSignature,
                  txHash,
                });
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected exactly one EVM League record block, found {count}")
path.write_text(text.replace(old, new, 1))
