// Where a gen-8 draft launch lands. A future openAt keeps the promotion page
// up. Trading, the coin page, and the launch feed wait until that time.
export function gen8DeployLanding({ openAt, slug, tokenAddress, chainId, nowSec }) {
  const open = Number(openAt);
  const now = Number(nowSec);
  if (Number.isFinite(open) && open > now && slug) {
    return { scheduledLaunchAt: open, path: `/prepare/${slug}` };
  }
  const chain = Number(chainId) || "";
  return { scheduledLaunchAt: null, path: `/token/${tokenAddress}?chainId=${chain}` };
}
