import { JsonRpcProvider } from "ethers";
import { Connection } from "@solana/web3.js";
import { resolveProjectOwnershipBnb } from "./projectOwnershipResolveBnb.js";
import { resolveProjectOwnershipSolana } from "./projectOwnershipResolveSolana.js";
import { registerProjectImportResolver } from "./projectImportResolvers.js";

const BNB_CHAIN_ID=56;
const SOLANA_CHAIN_ID=101;
let bnbProvider=null;
let solanaConnection=null;
function bnbRpcUrl(){return String(process.env.BNB_RPC_URL||process.env.BSC_RPC_URL||process.env.BSC_MAINNET_RPC_URL||"").trim();}
function solanaRpcUrl(){return String(process.env.SOLANA_RPC_URL||process.env.SOLANA_MAINNET_RPC_URL||"").trim();}
function getBnbProvider(){if(bnbProvider)return bnbProvider;const url=bnbRpcUrl();if(!url)throw Object.assign(new Error("BNB project import resolver is not configured"),{code:"PROJECT_IMPORT_RPC_UNAVAILABLE"});bnbProvider=new JsonRpcProvider(url,BNB_CHAIN_ID,{staticNetwork:true});return bnbProvider;}
function getSolanaConnection(){if(solanaConnection)return solanaConnection;const url=solanaRpcUrl();if(!url)throw Object.assign(new Error("Solana project import resolver is not configured"),{code:"PROJECT_IMPORT_RPC_UNAVAILABLE"});solanaConnection=new Connection(url,"confirmed");return solanaConnection;}
export function setProjectImportReadClientsForTest({bnb=null,solana=null}={}){bnbProvider=bnb;solanaConnection=solana;}
export async function resolveBnbProjectImport({chainId,tokenAddress,signedWallet}){const raw=await resolveProjectOwnershipBnb({provider:getBnbProvider(),chainId,contractAddress:tokenAddress,signedConnectedWallet:signedWallet});if(!raw?.ok)throw Object.assign(new Error(raw?.error||"BNB token resolution failed"),{code:raw?.errorCode||"PROJECT_IMPORT_RESOLVE_FAILED"});return{chainId:BNB_CHAIN_ID,tokenAddress:raw.contractAddress,name:raw.token?.name??null,symbol:raw.token?.symbol??null,decimals:raw.token?.decimals??null,totalSupply:raw.token?.totalSupply??null,automaticOwnershipAvailable:raw.ownership?.automaticOwnershipVerification!=="unavailable"&&Boolean(raw.ownership?.currentOwner),currentAuthority:raw.ownership?.currentOwner??null,signedWalletMatchesAuthority:Boolean(raw.ownership?.automaticOwnershipVerified)};}
export async function resolveSolanaProjectImport({chainId,tokenAddress,signedWallet}){if(Number(chainId)!==SOLANA_CHAIN_ID)throw Object.assign(new Error("Solana project import resolver only supports chain 101"),{code:"UNSUPPORTED_CHAIN"});const raw=await resolveProjectOwnershipSolana({mint:tokenAddress,connectedWallet:signedWallet,connection:getSolanaConnection()});if(!raw?.validMint)throw Object.assign(new Error(`Solana mint resolution failed: ${raw?.reason||"invalid mint"}`),{code:"SOLANA_MINT_INVALID"});return{chainId:SOLANA_CHAIN_ID,tokenAddress:raw.mint,name:null,symbol:null,decimals:raw.decimals,totalSupply:raw.totalSupply,automaticOwnershipAvailable:Boolean(raw.automaticVerificationAvailable),currentAuthority:raw.mintAuthority??null,signedWalletMatchesAuthority:Boolean(raw.verified)};}
export function registerDefaultProjectImportResolvers(){registerProjectImportResolver(BNB_CHAIN_ID,resolveBnbProjectImport);registerProjectImportResolver(SOLANA_CHAIN_ID,resolveSolanaProjectImport);}
