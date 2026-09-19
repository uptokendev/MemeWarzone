import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress } from "ethers";
import { resolveProjectOwnershipEvm } from "./projectOwnershipResolveEvm.js";

const iface=new Interface(["function name() view returns (string)","function symbol() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)","function owner() view returns (address)","function getOwner() view returns (address)"]);
const token="0x1111111111111111111111111111111111111111";
const owner="0x2222222222222222222222222222222222222222";
function provider(chainId=4663,currentOwner=owner){return{getNetwork:async()=>({chainId:BigInt(chainId)}),getCode:async()=>"0x6001600055",call:async({data})=>{for(const method of ["name","symbol","decimals","totalSupply","owner","getOwner"]){if(data===iface.encodeFunctionData(method)){if(method==="name")return iface.encodeFunctionResult(method,["Robin Meme"]);if(method==="symbol")return iface.encodeFunctionResult(method,["RHM"]);if(method==="decimals")return iface.encodeFunctionResult(method,[18]);if(method==="totalSupply")return iface.encodeFunctionResult(method,[1000000n]);return iface.encodeFunctionResult(method,[currentOwner]);}}throw new Error("unknown call");}};}

test("generic EVM resolver verifies exposed owner on Robinhood chain",async()=>{const r=await resolveProjectOwnershipEvm({provider:provider(),chainId:4663,contractAddress:token,signedConnectedWallet:owner});assert.equal(r.ok,true);assert.equal(r.chainId,4663);assert.equal(r.token.symbol,"RHM");assert.equal(r.ownership.automaticOwnershipVerified,true);});
test("generic EVM resolver rejects wrong wallet without trusting deployer history",async()=>{const r=await resolveProjectOwnershipEvm({provider:provider(),chainId:4663,contractAddress:token,signedConnectedWallet:"0x3333333333333333333333333333333333333333"});assert.equal(r.ok,true);assert.equal(r.ownership.currentOwner,owner);assert.equal(r.ownership.automaticOwnershipVerified,false);});
test("renounced owner becomes unavailable instead of auto-verifying",async()=>{const r=await resolveProjectOwnershipEvm({provider:provider(4663,ZeroAddress),chainId:4663,contractAddress:token,signedConnectedWallet:owner});assert.equal(r.ok,true);assert.equal(r.ownership.automaticOwnershipVerification,"unavailable");});
test("wrong RPC chain fails closed before token reads",async()=>{const r=await resolveProjectOwnershipEvm({provider:provider(56),chainId:4663,contractAddress:token,signedConnectedWallet:owner});assert.equal(r.ok,false);assert.equal(r.errorCode,"PROJECT_IMPORT_CHAIN_MISMATCH");});
