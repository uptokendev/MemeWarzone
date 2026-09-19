import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const local=name=>fileURLToPath(new URL(name,import.meta.url));
export default defineConfig({root:local('./'),resolve:{alias:[...['contexts/WalletContext','contexts/SolanaWalletContext','hooks/useActiveFeedWallet','lib/walletActionAuth','lib/solanaWallet','lib/apiBase','lib/chainConfig'].map(name=>({find:`@/${name}`,replacement:local('./mocks.tsx')})),{find:'@',replacement:local('../../src')}]},server:{fs:{allow:[local('../../')]}},esbuild:{jsx:'automatic'}});
