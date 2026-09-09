import {test,expect,type Page} from '@playwright/test';
const mint='7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump',owner='3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3',wrong='9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0N0AAAAASUVORK5CYII=','base64');
const resolved=(match:boolean)=>({chainId:101,tokenAddress:mint,currentAuthority:owner,automaticOwnershipAvailable:true,signedWalletMatchesAuthority:match,authoritySource:'pump_bonding_curve_creator',security:{status:'pass',criticalRisks:[],reviewRisks:[],provider:'fixture'}});
async function start(page:Page,wallet=wrong){await page.goto(`/?wallet=${wallet}`);await page.getByLabel('3. Contract Address').fill(mint);await page.getByRole('button',{name:'IMPORT',exact:true}).click();}
test('wrong wallet gets shortened creator warning, no image or manual bypass and no preliminary GET',async({page})=>{
  let lookups=0;page.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/project-imports'))lookups++;});
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(false),project:null}}));await start(page);
  await expect(page.getByRole('heading',{name:'NOT TOKEN OWNER'})).toBeVisible();await expect(page.locator('[data-import-wrong-wallet-warning]')).toContainText('3cG2...BrS3');await expect(page.locator('#project-import-image')).toHaveCount(0);await expect(page.getByRole('button',{name:'REQUEST MANUAL CHECK'})).toHaveCount(0);expect(lookups).toBe(0);
});
test('503 stays visible after a toast would expire and grants no image permission',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({status:503,json:{error:'Service unavailable'}}));await start(page);
  const error=page.locator('[data-import-error]');await expect(error).toContainText('IMPORT CHECK TEMPORARILY UNAVAILABLE');await page.waitForTimeout(5200);await expect(error).toBeVisible();await expect(page.getByRole('button',{name:'RETRY CHECK'})).toBeVisible();await expect(page.locator('#project-import-image')).toHaveCount(0);
});
test('manual image failure keeps saved review and retries image only',async({page})=>{
  const project={id:'fixture-project',chainId:101,tokenAddress:mint,ownershipStatus:'ownership_manual_review',manualClaimWallet:wrong,imageUrl:null};let requests=0,uploads=0;
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:{...resolved(false),currentAuthority:null,automaticOwnershipAvailable:false},project:null}}));
  await page.route('**/api/project-imports/manual-claim',r=>{requests++;return r.fulfill({json:{project}});});
  await page.route('**/api/project-imports/image?*',r=>{uploads++;return uploads===1?r.fulfill({status:503,json:{error:'Storage unavailable'}}):r.fulfill({json:{project:{...project,imageUrl:'https://example.test/project.png'}}});});
  await start(page);await page.locator('#project-import-image').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'REQUEST MANUAL CHECK'}).click();
  await expect(page.locator('[data-import-error]')).toBeVisible();await page.getByRole('button',{name:'ATTACH IMAGE TO REVIEW'}).click();await expect.poll(()=>uploads).toBe(2);expect(requests).toBe(1);await expect(page.locator('[data-import-error]')).toHaveCount(0);
});
test('wallet swap revokes old creator image permission immediately',async({page})=>{
  await page.route('**/api/project-imports/resolve',r=>r.fulfill({json:{resolved:resolved(true),project:null}}));await start(page,owner);await expect(page.locator('#project-import-image')).toBeVisible();await page.evaluate(address=>window.dispatchEvent(new CustomEvent('test-wallet-change',{detail:address})),wrong);await expect(page.locator('#project-import-image')).toHaveCount(0);
});
