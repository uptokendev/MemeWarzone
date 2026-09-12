import { resolvePumpOfficialX, resolveProjectImportImage } from '../api/lib/projectImportXClaim.js';

const mints = [
  ['INCOME', 'E7mRvAbgZdA6dF7cgXZevkbjd9Yfy5q11XEFnWZfpump'],
  ['PISSIN', 'A4STU4JNW9euEWnsqnTFxAJnTKrPgcw4XNJqYMG1pump'],
  ['TOEZ', '3DRCui7ZbEykhrUHMbyXSvn5731fbKchFTFvs1Wjpump'],
];

for (const [label, mint] of mints) {
  console.log(`\n=== ${label} ${mint} ===`);
  try {
    const identity = await resolvePumpOfficialX(mint);
    console.log('identity.ok', true);
    console.log('identity.username', identity.username);
    console.log('identity.xUrl', identity.xUrl);
    console.log('identity.source', identity.source);
    console.log('identity.metadataUrl', identity.metadataUrl);
  } catch (error) {
    console.log('identity.ok', false);
    console.log('identity.error', error?.message || String(error));
    console.log('identity.code', error?.code || null);
  }
  try {
    const image = await resolveProjectImportImage(101, mint);
    console.log('image.ok', Boolean(image?.imageUrl));
    console.log('image.url', image?.imageUrl || null);
    console.log('image.source', image?.source || null);
  } catch (error) {
    console.log('image.ok', false);
    console.log('image.error', error?.message || String(error));
  }
}
