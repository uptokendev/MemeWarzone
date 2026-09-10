import fs from 'node:fs';

function replaceExact(path, from, to) {
  const before = fs.readFileSync(path, 'utf8');
  if (!before.includes(from)) throw new Error(`Expected text not found in ${path}: ${from.slice(0, 100)}`);
  const after = before.replace(from, to);
  fs.writeFileSync(path, after);
}

const page = 'src/pages/ProjectImport.tsx';
const feedback = 'src/lib/projectImportFeedback.mjs';
const test = 'src/project-imports-ui.test.mjs';

replaceExact(page,
`function shortenWallet(value?: string | null) {
  const address = String(value || "").trim();
  if (address.length <= 8) return address;
  return \`${'${address.slice(0, 4)}'}...${'${address.slice(-4)}'}\`;
}`,
`function shortenWallet(value?: string | null) {
  const address = String(value || "").trim();
  if (address.length <= 8) return address;
  return \`${'${address.slice(0, 4)}'}...${'${address.slice(-4)}'}\`;
}
function simpleCheckTitle(key: string, fallback: string) {
  if (key === "identity") return "Token";
  if (key === "market") return "Trading market";
  if (key === "ownership") return "Ownership";
  if (key === "security") return "Safety";
  return fallback;
}
function simpleCheckStatus(status: string) {
  if (status === "pass") return "OK";
  if (status === "blocked") return "Blocked";
  if (status === "review") return "Needs a look";
  return "Couldn't verify";
}`);

replaceExact(page,
`Enter the existing token contract address. MemeWarzone validates the token, checks scam-risk signals and verifies that the connected wallet is its project wallet. Market stage, ownership and safety are separate checks; importing never unlocks Battles or trading.`,
`Enter the Contract Address and press IMPORT. We check the token, its market, safety and whether your wallet can manage it. If something cannot be confirmed automatically, you can ask our team to check it.`);

replaceExact(page,
`Add the image that should appear when the manual review is approved. The project remains hidden while review is pending.`,
`Add the image you want to use on MemeWarzone. If we need to review the token, it stays hidden until we approve it.`);

replaceExact(page,
`This token has not completed its bonding phase. New imports for the post-grad system must wait until graduation and market verification.`,
`This token is still in its bonding phase, so it cannot be imported yet. Try again after it graduates.`);

replaceExact(page,
`    {lookupComplete&&evidence?.market?.requiresLaunchReview&&!stillBonding&&!wrongAuthorityWallet?<section role="status" data-launch-history-review="true" className="rounded border p-4"><h2 className="font-retro text-sm">LAUNCH HISTORY REVIEW REQUIRED</h2><p className="mt-2 text-sm">A supported DEX pool was found, but a pool alone does not establish that this token is no longer bonding on another platform. Add your image and submit for review. The team will check launch history before approval.</p></section>:null}
    {marketReview&&!stillBonding&&!wrongAuthorityWallet?<section role="status" className="rounded border p-4"><h2 className="font-retro text-sm">TECHNICAL REVIEW REQUIRED</h2><p className="mt-2 text-sm">A supported post-grad market or complete check could not be established. You may save an image and request review, but the project will not be published until the required checks are complete. This is not a finding that the token is a scam.</p></section>:null}
    {assessment?.checks?.length&&!stillBonding?<details className="rounded border p-3" data-import-checks="true"><summary>What we checked</summary><div className="mt-3 space-y-3">{assessment.checks.map(check=><div key={check.key}><strong>{check.title}: {check.status}</strong><p className="text-sm">{check.finding}</p><p className="text-xs text-muted-foreground">Next: {check.nextAction}</p></div>)}</div></details>:null}`,
`    {canRequestManual?<section role="status" data-import-manual-summary="true" className="rounded border border-amber-300/40 bg-amber-400/10 p-4"><h2 className="font-retro text-sm text-amber-100">MANUAL CHECK NEEDED</h2><p className="mt-2 text-sm text-amber-50">We couldn't verify everything automatically. This does not mean your token is unsafe.</p><p className="mt-2 text-sm text-amber-50">Add your project image and send it to our team. We'll check the ownership, market status and any safety flags.</p></section>:null}
    {assessment?.checks?.length&&!stillBonding?<details className="rounded border p-3" data-import-checks="true"><summary>Why do we need to check it?</summary><p className="mt-2 text-xs text-muted-foreground">These are the checks that need a closer look.</p><div className="mt-3 space-y-3">{assessment.checks.map(check=><div key={check.key}><strong>{simpleCheckTitle(check.key,check.title)}: {simpleCheckStatus(check.status)}</strong><p className="text-sm">{check.finding}</p></div>)}</div></details>:null}`);

replaceExact(page,
`<h2 className="font-retro text-sm text-red-100">CREATOR WALLET DOES NOT MATCH</h2><p className="mt-2 text-sm text-red-50">The recorded creator wallet is <strong>{expectedAuthorityShort}</strong>. Connect and sign with that wallet to continue. These may both be your wallets; we need proof before granting project access.</p>`,
`<h2 className="font-retro text-sm text-red-100">NOT TOKEN OWNER</h2><p className="mt-2 text-sm text-red-50">This token is controlled by wallet <strong>{expectedAuthorityShort}</strong>. Connect that wallet to continue.</p>`);

replaceExact(page,
`{ownershipUnavailable&&!stillBonding?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-ownership-unavailable="true">`,
`{ownershipUnavailable&&!stillBonding&&!canRequestManual&&!manualReviewPending?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-ownership-unavailable="true">`);
replaceExact(page,
`{!stillBonding&&!wrongAuthorityWallet&&(securityBlocked||securityReview)&&!approvedOwner?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-security-review="true">`,
`{!stillBonding&&!wrongAuthorityWallet&&(securityBlocked||securityReview)&&!approvedOwner&&!canRequestManual&&!manualReviewPending?<div className="mt-4 rounded-md border border-amber-300/40 bg-amber-400/10 p-4" data-import-security-review="true">`);

replaceExact(page,
`Your request is in the web-dashboard review queue. The project stays hidden until an admin approves it.`,
`Your request is with our team. The project stays hidden until we approve it.`);
replaceExact(page,
`Manual review is available when automatic ownership cannot be proven or token-security checks require review. A known different owner wallet cannot use this fallback.`,
`Add an image, then send the token to our team. If we already know another wallet controls the token, manual review is not available.`);
replaceExact(page,
`Token checks passed, the connected wallet matches the current token authority, and the automatic scam-risk scan passed. Upload the project image to continue.`,
`All automatic checks passed and this wallet matches the token owner. Add the project image to finish.`);

replaceExact(feedback,
`return { title: 'CREATOR WALLET DOES NOT MATCH', message: \`The recorded creator wallet is ${'${short}'}. Connect that wallet to continue.\`, retry: false };`,
`return { title: 'NOT TOKEN OWNER', message: \`This token is controlled by wallet ${'${short}'}. Connect that wallet to continue.\`, retry: false };`);
replaceExact(feedback,
`if (code === "PROJECT_IMPORT_REVIEW_REQUIRED") return {title:"ADDITIONAL REVIEW REQUIRED",message:"The latest ownership, market or safety checks need review. Run the checks again for the next step.",retry:true};`,
`if (code === "PROJECT_IMPORT_REVIEW_REQUIRED") return {title:"MANUAL CHECK NEEDED",message:"We couldn't verify everything automatically. Add an image and send the token to our team.",retry:true};`);
replaceExact(feedback,
`return { title: 'IMPORT CHECK TEMPORARILY UNAVAILABLE', message: 'We could not complete this request. Nothing has been approved by this failed check. Please retry.', retry: true };`,
`return { title: 'IMPORT CHECK TEMPORARILY UNAVAILABLE', message: 'We could not finish the checks. Nothing was approved. Please try again.', retry: true };`);

replaceExact(test,
`assert.match(importPage, /CREATOR WALLET DOES NOT MATCH/); assert.match(importPage, /The recorded creator wallet is/); assert.match(importPage, /Connect and sign with that wallet to continue/);`,
`assert.match(importPage, /NOT TOKEN OWNER/); assert.match(importPage, /This token is controlled by wallet/); assert.match(importPage, /Connect that wallet to continue/);`);
replaceExact(test,
`assert.match(importPage, /uploadPendingImage/); assert.match(importPage, /ATTACH IMAGE TO REVIEW/); assert.match(importPage, /project stays hidden until an admin approves it/);`,
`assert.match(importPage, /uploadPendingImage/); assert.match(importPage, /ATTACH IMAGE TO REVIEW/); assert.match(importPage, /MANUAL CHECK NEEDED/); assert.match(importPage, /project stays hidden until we approve it/);`);

console.log('Simplified import review copy without changing import decisions or permissions.');
