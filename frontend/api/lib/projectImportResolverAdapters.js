import { JsonRpcProvider } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveProjectOwnershipBnb } from "./projectOwnershipResolveBnb.js";
import { resolveProjectOwnershipSolana } from "./projectOwnershipResolveSolana.js";
import { registerProjectImportResolver } from "./projectImportResolvers.js";

const BNB_CHAIN_ID=56;
const SOLANA_CHAIN_ID=101;
const TOKEN_METADATA_PROGRAM_ID=new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
let bnbProvider=null;
let solanaConnection=null;
function bnbRpcUrl(){return String(process.env.BNB_RPC_URL||process.env.BSC_RPC_URL||process.env.BSC_MAINNET_RPC_URL||"").trim();}
function solanaRpcUrl(){return String(process.env.SOLANA_RPC_URL||process.env.SOLANA_MAINNET_RPC_URL||"").trim();}
function getBnbProvider(){if(bnbProvider)return bnbProvider;const url=bnbRpcUrl();if(!url)throw Object.assign(new Error("BNB project import resolver is not configured"),{code:"PROJECT_IMPORT_RPC_UNAVAILABLE"});bnbProvider=new JsonRpcProvider(url,BNB_CHAIN_ID,{staticNetwork:true});return bnbProvider;}
function getSolanaConnection(){if(solanaConnection)return solanaConnection;const url=solanaRpcUrl();if(!url)throw Object.assign(new Error("Solana project import resolver is not configured"),{code:"PROJECT_IMPORT_RPC_UNAVAILABLE"});solanaConnection=new Connection(url,"confirmed");return solanaConnection;}
export function setProjectImportReadClientsForTest({bnb=null,solana=null}={}){bnbProvider=bnb;solanaConnection=solana;}
export async function resolveBnbProjectImport({chainId,tokenAddress,signedWallet}){const raw=await resolveProjectOwnershipBnb({provider:getBnbProvider(),chainId,contractAddress:tokenAddress,signedConnectedWallet:signedWallet});if(!raw?.ok)throw Object.assign(new Error(raw?.error||"BNB token resolution failed"),{code:raw?.errorCode||"PROJECT_IMPORT_RESOLVE_FAILED"});return{chainId:BNB_CHAIN_ID,tokenAddress:raw.contractAddress,name:raw.token?.name??null,symbol:raw.token?.symbol??null,decimals:raw.token?.decimals??null,totalSupply:raw.token?.totalSupply??null,automaticOwnershipAvailable:raw.ownership?.automaticOwnershipVerification!=="unavailable"&&Boolean(raw.ownership?.currentOwner),currentAuthority:raw.ownership?.currentOwner??null,signedWalletMatchesAuthority:Boolean(raw.ownership?.automaticOwnershipVerified)};}

function readMetadataString(data,offset,maxBytes){if(offset+4>data.length)throw new Error("metadata string length missing");const length=data.readUInt32LE(offset);const start=offset+4,end=start+length;if(length>maxBytes||end>data.length)throw new Error("metadata string invalid");return{value:data.subarray(start,end).toString("utf8").replace(/\0/g,"").trim(),next:end};}
export async function resolveSolanaDisplayMetadata(connection,mint){
  try{
    const mintKey=mint instanceof PublicKey?mint:new PublicKey(String(mint));
    const [metadataAddress]=PublicKey.findProgramAddressSync([Buffer.from("metadata"),TOKEN_METADATA_PROGRAM_ID.toBuffer(),mintKey.toBuffer()],TOKEN_METADATA_PROGRAM_ID);
    const account=await connection.getAccountInfo(metadataAddress,"confirmed");
    if(!account?.data||!account.owner?.equals?.(TOKEN_METADATA_PROGRAM_ID))return{name:null,symbol:null};
    const data=Buffer.from(account.data);
    if(data.length<65)return{name:null,symbol:null};
    const name=readMetadataString(data,65,256);
    const symbol=readMetadataString(data,name.next,64);
    return{name:name.value||null,symbol:symbol.value||null};
  }catch{return{name:null,symbol:null};}
}
export async function resolveSolanaProjectImport({chainId,tokenAddress,signedWallet}){if(Number(chainId)!==SOLANA_CHAIN_ID)throw Object.assign(new Error("Solana project import resolver only supports chain 101"),{code:"UNSUPPORTED_CHAIN"});const connection=getSolanaConnection();const raw=await resolveProjectOwnershipSolana({mint:tokenAddress,connectedWallet:signedWallet,connection});if(!raw?.validMint)throw Object.assign(new Error(`Solana mint resolution failed: ${raw?.reason||"invalid mint"}`),{code:"SOLANA_MINT_INVALID"});const metadata=await resolveSolanaDisplayMetadata(connection,raw.mint);return{chainId:SOLANA_CHAIN_ID,tokenAddress:raw.mint,name:metadata.name,symbol:metadata.symbol,decimals:raw.decimals,totalSupply:raw.totalSupply,automaticOwnershipAvailable:Boolean(raw.automaticVerificationAvailable),currentAuthority:raw.mintAuthority??null,signedWalletMatchesAuthority:Boolean(raw.verified)};}
export function registerDefaultProjectImportResolvers(){registerProjectImportResolver(BNB_CHAIN_ID,resolveBnbProjectImport);registerProjectImportResolver(SOLANA_CHAIN_ID,resolveSolanaProjectImport);}
