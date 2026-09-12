import { Connection, PublicKey } from '@solana/web3.js';
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const mint = new PublicKey('E7mRvAbgZdA6dF7cgXZevkbjd9Yfy5q11XEFnWZfpump');
const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpc, 'confirmed');
const metadataProgram = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const pumpProgram = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), metadataProgram.toBuffer(), mint.toBuffer()], metadataProgram);
const [curve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], pumpProgram);

function readString(data, offset) {
  if (offset + 4 > data.length) return { value: null, next: data.length, error: 'missing_length' };
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > data.length) return { value: null, next: data.length, error: `length_${len}_past_${data.length}` };
  return { value: data.subarray(start, end).toString('utf8').replace(/\0/g, '').trim(), next: end, len };
}

console.log('rpc', rpc);
console.log('genesis', await connection.getGenesisHash());
const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
console.log('mint.exists', !!mintInfo);
console.log('mint.owner', mintInfo?.owner?.toBase58?.());
console.log('mint.data.length', mintInfo?.data?.length);
console.log('token2022.program', TOKEN_2022_PROGRAM_ID.toBase58());
console.log('metadata.pda', metadata.toBase58());
const metaInfo = await connection.getAccountInfo(metadata, 'confirmed');
console.log('metadata.exists', !!metaInfo);
console.log('metadata.owner', metaInfo?.owner?.toBase58?.());
console.log('metadata.data.length', metaInfo?.data?.length);
if (metaInfo?.data) {
  const data = Buffer.from(metaInfo.data);
  console.log('metadata.key', data[0]);
  const name = readString(data, 65);
  const symbol = readString(data, name.next);
  const uri = readString(data, symbol.next);
  console.log('metadata.name', name);
  console.log('metadata.symbol', symbol);
  console.log('metadata.uri', uri);
}
console.log('curve.pda', curve.toBase58());
const curveInfo = await connection.getAccountInfo(curve, 'confirmed');
console.log('curve.exists', !!curveInfo);
console.log('curve.owner', curveInfo?.owner?.toBase58?.());
console.log('curve.data.length', curveInfo?.data?.length);
try {
  const token2022Metadata = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  console.log('token2022.metadata', token2022Metadata);
  if (token2022Metadata?.uri) {
    const response = await fetch(token2022Metadata.uri, { redirect: 'follow', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
    console.log('metadata.http.status', response.status);
    console.log('metadata.http.finalUrl', response.url);
    console.log('metadata.http.contentType', response.headers.get('content-type'));
    const text = await response.text();
    console.log('metadata.http.bodyPrefix', text.slice(0, 1000));
  }
} catch (error) {
  console.log('token2022.error', error?.message || String(error));
}
