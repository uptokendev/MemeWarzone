"use strict";
const fs=require("fs");
const {Connection,Keypair,PublicKey,Transaction,AddressLookupTableProgram}=require("../tests/solana/node_modules/@solana/web3.js");
const EXPECTED_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const EXPECTED_OPERATOR="HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
const ALT_KEY=new PublicKey("EdNwQtwKnVHPBe7rSBuUnGxD9StmWcUDK2AHNbDauMoL");
const EXPECTED_OWNER="AddressLookupTab1e1111111111111111111111111";
const EXPECTED_RENT=3373120;
const EXPECTED_ADDRESSES=15;
function loadKeypair(file){return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file,"utf8"))));}
async function main(){
  const operator=loadKeypair(process.env.SOLANA_OPERATOR_KEYPAIR);
  if(operator.publicKey.toBase58()!==EXPECTED_OPERATOR)throw new Error(`unapproved operator ${operator.publicKey.toBase58()}`);
  const c=new Connection(process.env.SOLANA_RPC_URL,"confirmed");
  if((await c.getGenesisHash())!==EXPECTED_GENESIS)throw new Error("not devnet");
  const send=async(ix,label)=>{const latest=await c.getLatestBlockhash("confirmed");const tx=new Transaction({feePayer:operator.publicKey,recentBlockhash:latest.blockhash}).add(ix);tx.sign(operator);const sig=await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});const conf=await c.confirmTransaction({signature:sig,...latest},"confirmed");if(conf.value.err)throw new Error(`${label} failed ${JSON.stringify(conf.value.err)}`);console.log(`${label}_TX`,sig);return sig;};
  const before=await c.getBalance(operator.publicKey,"confirmed");
  let info=await c.getAccountInfo(ALT_KEY,"confirmed");let table=(await c.getAddressLookupTable(ALT_KEY)).value;
  console.log("OPERATOR_BALANCE_PRE_RECLAIM",before);
  if(!info&&!table){console.log("RECLAIMABLE_ALT_ALREADY_CLOSED");console.log("OPERATOR_BALANCE_POST_RECLAIM",before);return;}
  if(!info||!table)throw new Error("reclaimable ALT malformed");
  if(info.owner.toBase58()!==EXPECTED_OWNER)throw new Error(`wrong ALT owner ${info.owner.toBase58()}`);
  if(!table.state.authority?.equals(operator.publicKey))throw new Error(`wrong ALT authority ${table.state.authority?.toBase58()}`);
  if(table.state.addresses.length!==EXPECTED_ADDRESSES)throw new Error(`unexpected ALT addresses ${table.state.addresses.length}`);
  if(info.lamports!==EXPECTED_RENT)throw new Error(`unexpected ALT rent ${info.lamports}`);
  console.log("RECLAIMABLE_ALT_VERIFIED",ALT_KEY.toBase58(),"LAMPORTS",info.lamports,"ADDRESSES",table.state.addresses.length);
  const MAX=BigInt("18446744073709551615");let deactivation=BigInt(table.state.deactivationSlot.toString());
  if(deactivation===MAX){await send(AddressLookupTableProgram.deactivateLookupTable({lookupTable:ALT_KEY,authority:operator.publicKey}),"ALT_DEACTIVATE");table=(await c.getAddressLookupTable(ALT_KEY)).value;if(!table)throw new Error("ALT vanished after deactivate");deactivation=BigInt(table.state.deactivationSlot.toString());}
  for(let i=0;i<180;i++){const slot=BigInt(await c.getSlot("confirmed"));const age=slot-deactivation;if(i%10===0)console.log("ALT_COOLDOWN_SLOT",slot.toString(),"AGE",age.toString());if(age>=520n)break;await new Promise(r=>setTimeout(r,2500));}
  const current=BigInt(await c.getSlot("confirmed"));if(current-deactivation<520n)throw new Error(`ALT cooldown incomplete ${current-deactivation}`);
  await send(AddressLookupTableProgram.closeLookupTable({lookupTable:ALT_KEY,authority:operator.publicKey,recipient:operator.publicKey}),"ALT_CLOSE");
  if(await c.getAccountInfo(ALT_KEY,"confirmed"))throw new Error("ALT still exists after close");
  const after=await c.getBalance(operator.publicKey,"confirmed");console.log("OPERATOR_BALANCE_POST_RECLAIM",after);console.log("RECLAIMED_NET",after-before);if(after<=before)throw new Error("ALT rent not reclaimed");
}
main().catch(e=>{console.error(e?.stack||e);process.exit(1)});
