import {test,expect,type Page} from '@playwright/test';
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump',owner='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3',wrong='9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0N0AAAAASUVORK5CYII=','base64');
const resolved=(match:boolean)=>({chainId:101,tokenAddress:mint,currentAuthority:owner,automaticOwnershipAvailable:true,signedWalletMatchesAuthority:match,authoritySource:'pump_bonding_curve_creator',market:{phase:'postgrad',verified:true},assessment:{decision:match?'automatic':'wrong_wallet',automaticImportAllowed:match,manualRequestAllowed:false,checks:[]},security:{status:'pass',criticalRisks:[],reviewRisks:[],provider:'fixture'}});
async function start(page:Page,wallet=wrong){await page.goto(`/?wallet=${wallet}`);await page.getByLabel('3. Contract Address').fill(mint);await page.getByRole('button',{name:'IMPORT',exact:true}).click();}
test('wrong wallet gets shortened creator warning, no image or manual bypass and no preliminary GET',async({page})=>{
  let lookups=0;page.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/project-imports'))lookups++;});
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(false),project:null}}));await start(page);
  await expect(page.getByRole('heading',{name:'CREATOR WALLET DOES NOT MATCH'})).toBeVisible();await expect(page.locator('[data-import-wrong-wallet-warning]')).toContainText('3cG2...BrS3');await expect(page.locator('#project-import-image')).toHaveCount(0);await expect(page.getByRole('button',{name:'REQUEST MANUAL CHECK'})).toHaveCount(0);expect(lookups).toBe(0);
});
test('503 stays visible after a toast would expire and grants no image permission',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({status:503,json:{error:'Service unavailable'}}));await start(page);
  const error=page.locator('[data-import-error]');await expect(error).toContainText('IMPORT CHECK TEMPORARILY UNAVAILABLE');await page.waitForTimeout(5200);await expect(error).toBeVisible();await expect(page.getByRole('button',{name:'RETRY CHECK'})).toBeVisible();await expect(page.locator('#project-import-image')).toHaveCount(0);
});
test('manual image failure keeps saved review and retries image only',async({page})=>{
  const project={id:'fixture-project',chainId:101,tokenAddress:mint,ownershipStatus:'ownership_manual_review',manualClaimWallet:wrong,imageUrl:null};let requests=0,uploads=0;
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:{...resolved(false),currentAuthority:null,automaticOwnershipAvailable:false,assessment:{decision:'manual_review',automaticImportAllowed:false,manualRequestAllowed:true,checks:[]}},project:null}}));
  await page.route('**/api/project-imports/manual-claim',r=>{requests++;return r.fulfill({json:{project}});});
  await page.route('**/api/project-imports/image?*',r=>{uploads++;return uploads===1?r.fulfill({status:503,json:{error:'Storage unavailable'}}):r.fulfill({json:{project:{...project,imageUrl:'https://example.test/project.png'}}});});
  await start(page);await page.locator('#project-import-image').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'REQUEST MANUAL CHECK'}).click();
  await expect(page.locator('[data-import-error]')).toBeVisible();await page.getByRole('button',{name:'ATTACH IMAGE TO REVIEW'}).click();await expect.poll(()=>uploads).toBe(2);expect(requests).toBe(1);await expect(page.locator('[data-import-error]')).toHaveCount(0);
});
test('wallet swap revokes old creator image permission immediately',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(true),project:null}}));await start(page,owner);await expect(page.locator('#project-import-image')).toBeVisible();await page.evaluate(address=>window.dispatchEvent(new CustomEvent('test-wallet-change',{detail:address})),wrong);await expect(page.locator('#project-import-image')).toHaveCount(0);
});

test('bonding token cannot select image or request manual bypass',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:{...resolved(true),market:{phase:'bonding',verified:true},assessment:{decision:'not_eligible',automaticImportAllowed:false,manualRequestAllowed:false,checks:[]}},project:null}}));
  await start(page,owner);await expect(page.locator('[data-import-bonding]')).toContainText('STILL BONDING');await expect(page.locator('#project-import-image')).toHaveCount(0);await expect(page.getByRole('button',{name:'REGISTER MEMECOIN'})).toHaveCount(0);await expect(page.getByRole('button',{name:'REQUEST MANUAL CHECK'})).toHaveCount(0);
});
test('Pump help explains fee accounts and never collects a private key',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Got a Pump.fun token?'}).click();const popup=page.locator('[data-pump-import-help]');await expect(popup).toContainText('It has no private key to import');await page.getByRole('button',{name:'Phantom guide',exact:true}).click();await expect(popup).toContainText('Never paste a private key');await expect(popup.locator('input,textarea')).toHaveCount(0);await expect(popup.getByRole('link',{name:'Official Phantom instructions'})).toHaveAttribute('href',/^https:\/\/help.phantom.com\//);await page.keyboard.press('Escape');await expect(popup).toHaveCount(0);
});
test('verified import retries only its failed image',async({page})=>{
 const project={id:'verified-fixture',chainId:101,tokenAddress:mint,ownershipStatus:'ownership_verified',projectOwnerWallet:owner,imageUrl:null};let registrations=0,uploads=0;
 await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(true),project:null}}));await page.route('**/api/project-imports',r=>{registrations++;return r.fulfill({json:{created:true,project}});});await page.route('**/api/project-imports/image?*',r=>{uploads++;return uploads===1?r.fulfill({status:503,json:{error:'Storage unavailable'}}):r.fulfill({json:{project:{...project,imageUrl:'https://example.test/image.png'}}});});
 await start(page,owner);await page.locator('#project-import-image').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'REGISTER MEMECOIN'}).click();await expect(page.locator('[data-import-error]')).toContainText('IMAGE UPLOAD NOT COMPLETED');await page.getByRole('button',{name:'ATTACH REQUIRED IMAGE'}).click();await expect(page.getByRole('button',{name:'OPEN PROJECT PAGE'})).toBeVisible();expect(registrations).toBe(1);expect(uploads).toBe(2);
});
test('wrong-family address remains explained inline',async({page})=>{await page.goto('/');await page.getByLabel('3. Contract Address').fill('0x1111111111111111111111111111111111111111');await expect(page.getByRole('alert')).toContainText('not valid for the selected chain');await expect(page.getByRole('button',{name:'IMPORT',exact:true})).toBeDisabled();});

test('matched wallet and clean scan still permit image plus manual launch-history review',async({page})=>{
 await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:{...resolved(true),market:{phase:'dex_market',verified:true,requiresLaunchReview:true},assessment:{decision:'manual_review',automaticImportAllowed:false,manualRequestAllowed:true,checks:[]}},project:null}}));await start(page,owner);
 await expect(page.locator('[data-launch-history-review]')).toContainText('a pool alone');await expect(page.locator('#project-import-image')).toBeVisible();await expect(page.getByRole('button',{name:'REGISTER MEMECOIN'})).toHaveCount(0);await page.locator('#project-import-image').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:png});await expect(page.getByRole('button',{name:'REQUEST MANUAL CHECK'})).toBeEnabled();
});
test('Four bonding message does not incorrectly name Pump.fun',async({page})=>{
 await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:{...resolved(true),market:{phase:'bonding',verified:true,platform:'fourmeme'},assessment:{decision:'not_eligible',automaticImportAllowed:false,manualRequestAllowed:false,checks:[]}},project:null}}));await start(page,owner);await expect(page.locator('[data-import-bonding]')).toContainText('STILL BONDING ON FOUR.MEME');await expect(page.locator('#project-import-image')).toHaveCount(0);
});
