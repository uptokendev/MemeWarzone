import { Connection, PublicKey } from '@solana/web3.js';
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpc, 'confirmed');
const metadataProgram = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const pumpProgram = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const mints = [
  ['INCOME', 'E7mRvAbgZdA6dF7cgXZevkbjd9Yfy5q11XEFnWZfpump'],
  ['PISSIN', 'A4STU4JNW9euEWnsqnTFxAJnTKrPgcw4XNJqYMG1pump'],
  ['TOEZ', '3DRCui7ZbEykhrUHMbyXSvn5731fbKchFTFvs1Wjpump'],
];

function readString(data, offset) {
  if (offset + 4 > data.length) return { value: null, next: data.length };
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > data.length) return { value: null, next: data.length };
  return { value: data.subarray(start, end).toString('utf8').replace(/\0/g, '').trim(), next: end };
}

function ipfsPath(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('ipfs://')) return value.slice('ipfs://'.length).replace(/^ipfs\//, '');
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/ipfs\/(.+)$/);
    return match?.[1] || null;
  } catch { return null; }
}

async function probeUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        'user-agent': 'MemeWarzone-Metadata-Probe/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      finalUrl: res.url,
      contentType: res.headers.get('content-type'),
      server: res.headers.get('server'),
      bodyPrefix: text.slice(0, 700),
    };
  } catch (error) {
    return { error: error?.message || String(error), cause: error?.cause?.message || null };
  }
}

console.log('genesis', await connection.getGenesisHash());
for (const [label, mintText] of mints) {
  const mint = new PublicKey(mintText);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), metadataProgram.toBuffer(), mint.toBuffer()], metadataProgram);
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], pumpProgram);
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  const metaInfo = await connection.getAccountInfo(metadata, 'confirmed');
  const curveInfo = await connection.getAccountInfo(curve, 'confirmed');
  let classic = null;
  if (metaInfo?.data) {
    const data = Buffer.from(metaInfo.data);
    const name = readString(data, 65);
    const symbol = readString(data, name.next);
    const uri = readString(data, symbol.next);
    classic = { name: name.value, symbol: symbol.value, uri: uri.value };
  }
  let token2022 = null;
  let token2022Error = null;
  try {
    token2022 = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch (error) {
    token2022Error = error?.message || String(error);
  }
  const chosenUri = classic?.uri || token2022?.uri || null;
  console.log('\n===', label, mintText, '===');
  console.log('mint.owner', mintInfo?.owner?.toBase58?.(), 'len', mintInfo?.data?.length);
  console.log('curve.exists', !!curveInfo, 'curve.owner', curveInfo?.owner?.toBase58?.());
  console.log('classic', classic);
  console.log('token2022', token2022 && { name: token2022.name, symbol: token2022.symbol, uri: token2022.uri, additionalMetadata: token2022.additionalMetadata });
  console.log('token2022.error', token2022Error);
  console.log('chosenUri', chosenUri);
  console.log('fetch.original', await probeUrl(chosenUri));
  const path = ipfsPath(chosenUri);
  if (path) {
    for (const [gateway, url] of [
      ['cf-ipfs.com', `https://cf-ipfs.com/ipfs/${path}`],
      ['cloudflare-ipfs.com', `https://cloudflare-ipfs.com/ipfs/${path}`],
      ['gateway.pinata.cloud', `https://gateway.pinata.cloud/ipfs/${path}`],
      ['pump.mypinata.cloud', `https://pump.mypinata.cloud/ipfs/${path}`],
    ]) console.log(`fetch.${gateway}`, await probeUrl(url));
  }
}
