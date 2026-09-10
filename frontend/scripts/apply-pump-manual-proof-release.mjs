import fs from 'node:fs';

function replaceExact(path, from, to) {
  const before = fs.readFileSync(path, 'utf8');
  if (!before.includes(from)) throw new Error(`Expected text not found in ${path}: ${from.slice(0,120)}`);
  fs.writeFileSync(path, before.replace(from, to));
}

const assessment='api/lib/projectImportAssessment.js';
const api='api/projectImports.js';
const page='src/pages/ProjectImport.tsx';
const tests='src/project-imports-ui.test.mjs';

replaceExact(assessment,
`  const mismatch=known&&!match;\n  const bonding=market.verified===true&&market.phase==='bonding';`,
`  const mismatch=known&&!match;\n  // Pump.fun commonly creates a separate embedded creator wallet. A known Pump creator\n  // mismatch may enter MANUAL ownership review, but never automatic import. The reviewer\n  // still needs independent project authorization (or a later cryptographic creator proof).\n  const pumpCreatorMismatch=mismatch&&resolved.authoritySource==='pump_bonding_curve_creator';\n  const bonding=market.verified===true&&market.phase==='bonding';`);
replaceExact(assessment,
`  const manualRequestAllowed=!bonding&&!mismatch&&!automaticImportAllowed;\n  const decision=bonding?'not_eligible':mismatch?'wrong_wallet':technicalFailure||!postgrad||!marketControlsOk?'technical_review':automaticImportAllowed?'automatic':'manual_review';`,
`  const manualRequestAllowed=!bonding&&!automaticImportAllowed&&(!mismatch||pumpCreatorMismatch);\n  const decision=bonding?'not_eligible':mismatch&&!pumpCreatorMismatch?'wrong_wallet':technicalFailure||!postgrad||!marketControlsOk?'technical_review':automaticImportAllowed?'automatic':'manual_review';`);
replaceExact(assessment,
`    canVerifyOwner:!bonding&&!mismatch&&postgrad&&!technicalFailure&&marketControlsOk&&['pass','review'].includes(security?.status),`,
`    canVerifyOwner:!bonding&&(!mismatch||pumpCreatorMismatch)&&postgrad&&!technicalFailure&&marketControlsOk&&['pass','review'].includes(security?.status),`);
replaceExact(assessment,
`||snapshot.authority?.status==='mismatch'||snapshot.market?.pricingValid===false`,
`||snapshot.market?.pricingValid===false`);

replaceExact(api,
`      if (resolved.automaticOwnershipAvailable && !resolved.signedWalletMatchesAuthority) requireResolvedOwner(resolved);\n      if (!assessment.manualRequestAllowed`,
`      const pumpCreatorMismatch = resolved.automaticOwnershipAvailable === true && !resolved.signedWalletMatchesAuthority && resolved.authoritySource === "pump_bonding_curve_creator";\n      if (resolved.automaticOwnershipAvailable && !resolved.signedWalletMatchesAuthority && !pumpCreatorMismatch) requireResolvedOwner(resolved);\n      if (!assessment.manualRequestAllowed`);

replaceExact(page,
`  const wrongAuthorityWallet=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana");`,
`  const reviewablePumpMismatch=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana")&&evidence?.authoritySource==="pump_bonding_curve_creator"&&assessment?.manualRequestAllowed===true;\n  const wrongAuthorityWallet=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana")&&!reviewablePumpMismatch;`);

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
`    {lookupComplete&&evidence?.market?.requiresLaunchReview&&!stillBonding&&!wrongAuthorityWallet?<section role="status" data-launch-history-review="true" className="rounded border p-4"><h2 className="font-retro text-sm">LAUNCH HISTORY REVIEW REQUIRED</h2><p className="mt-2 text-sm">A supported DEX pool was found, but a pool alone does not establish that this token is no longer bonding on another platform. Add your image and submit for review. The team will check launch history before approval.</p></section>:null}\n    {marketReview&&!stillBonding&&!wrongAuthorityWallet?<section role="status" className="rounded border p-4"><h2 className="font-retro text-sm">TECHNICAL REVIEW REQUIRED</h2><p className="mt-2 text-sm">A supported post-grad market or complete check could not be established. You may save an image and request review, but the project will not be published until the required checks are complete. This is not a finding that the token is a scam.</p></section>:null}`,
`    {canRequestManual?<section role="status" data-import-manual-summary="true" className="rounded border border-amber-300/40 bg-amber-400/10 p-4"><h2 className="font-retro text-sm text-amber-100">MANUAL CHECK NEEDED</h2><p className="mt-2 text-sm text-amber-50">We couldn't verify everything automatically. This does not mean there is something wrong with your token.</p><p className="mt-2 text-sm text-amber-50">Add your project image and send it to our team. We'll check the ownership, market status and safety flags.</p>{reviewablePumpMismatch?<p className="mt-2 text-sm text-amber-50"><strong>Pump.fun wallet:</strong> We found creator wallet {expectedAuthorityShort}, but you are connected with {connectedWalletShort}. Pump.fun often uses a separate creator wallet. You can still request review and prove the project through its official account.</p>:null}</section>:null}`);
replaceExact(page,
`<summary>What we checked</summary>`,
`<summary>Why do we need to check it?</summary>`);
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
`{manualReviewMine&&!stillBonding?<Button type="button" className="mt-3"`,
`{manualReviewMine&&reviewablePumpMismatch?<div className="mt-3 rounded border border-sky-200/30 p-3 text-sm"><strong>Easy project proof</strong><p className="mt-1">Post this one-time claim code from the project's official X, Telegram announcement channel or website:</p><code className="mt-2 block select-all break-all">MWZ-{item?.id?.slice(0,8).toUpperCase()}</code><p className="mt-2 text-xs">Then send the public post/link to our reviewer. Never send us a private key or recovery phrase.</p></div>:null}{manualReviewMine&&!stillBonding?<Button type="button" className="mt-3"`);
replaceExact(page,
`Manual review is available when automatic ownership cannot be proven or token-security checks require review. A known different owner wallet cannot use this fallback.`,
`Add an image, then send the token to our team. For Pump.fun creator-wallet mismatches, we can verify you through the project's official account. Other known wallet mismatches stay blocked.`);
replaceExact(page,
`Token checks passed, the connected wallet matches the current token authority, and the automatic scam-risk scan passed. Upload the project image to continue.`,
`All automatic checks passed and this wallet matches the token owner. Add the project image to finish.`);

replaceExact(tests,
`assert.match(importPage, /CREATOR WALLET DOES NOT MATCH/); assert.match(importPage, /The recorded creator wallet is/); assert.match(importPage, /Connect and sign with that wallet to continue/);`,
`assert.match(importPage, /NOT TOKEN OWNER/); assert.match(importPage, /This token is controlled by wallet/); assert.match(importPage, /Connect that wallet to continue/);`);
replaceExact(tests,
`  assert.match(importPage, /canRequestManual=.*?!wrongAuthorityWallet/);`,
`  assert.match(importPage, /canRequestManual=.*?!wrongAuthorityWallet/);\n  assert.match(importPage, /reviewablePumpMismatch/); assert.match(importPage, /Easy project proof/); assert.match(importPage, /MWZ-/);`);
replaceExact(tests,
`assert.match(importPage, /uploadPendingImage/); assert.match(importPage, /ATTACH IMAGE TO REVIEW/); assert.match(importPage, /project stays hidden until an admin approves it/);`,
`assert.match(importPage, /uploadPendingImage/); assert.match(importPage, /ATTACH IMAGE TO REVIEW/); assert.match(importPage, /MANUAL CHECK NEEDED/); assert.match(importPage, /project stays hidden until we approve it/);`);

console.log('Applied Pump.fun alternate manual ownership proof + simpler creator copy.');
