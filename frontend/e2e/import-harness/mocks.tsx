import { useEffect,useState } from 'react';
function useAccount(){const [account,setAccount]=useState(new URLSearchParams(location.search).get('wallet')||'9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H');useEffect(()=>{const listener=(e:any)=>setAccount(e.detail);window.addEventListener('test-wallet-change',listener);return ()=>window.removeEventListener('test-wallet-change',listener);},[]);return account;}
export const BNB_CHAIN_ID=56,SOLANA_CHAIN_ID=101;
export function useWallet(){return {account:null,connecting:false,signer:null,connect:async()=>{}};}
export function useSolanaWallet(){return {solanaAccount:useAccount(),connectingSolana:false,connectSolana:async()=>{}};}
export function useActiveFeedWallet(){const account=useAccount();return {solanaAccount:account,evmAccount:null,isSolana:true,address:account};}
export async function signWalletAction(input:any){return {...input,extraLines:undefined,signer:undefined,signMessage:undefined,nonce:'browser-fixture',signature:'browser-fixture',message:'browser-fixture'};}
export async function signSolanaMessage(){return {signature:'browser-fixture'};}
export const apiFetch=(path:string,init?:RequestInit)=>fetch(path,init);
export function appendAuthToSearchParams(params:URLSearchParams,auth:Record<string,unknown>){for(const [key,value]of Object.entries(auth))if(value!=null)params.set(key,String(value));}
