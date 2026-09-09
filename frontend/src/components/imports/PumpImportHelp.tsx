import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

const GUIDES = {
  pump: 'https://intercom.help/pumpfun-web/en/articles/13644291-how-to-export-seed-phrase-or-private-key-on-the-mobile-app',
  phantom: 'https://help.phantom.com/articles/how-to-import-a-privy-wallet-into-phantom-41408635409683',
  solflare: 'https://help.solflare.com/en/articles/6462529-how-to-import-a-wallet-using-a-private-key-on-solflare-mobile',
};
export function PumpImportHelp({ onConnect, expectedCreator, disabled = false }: { onConnect: () => void; expectedCreator?: string | null; disabled?: boolean }) {
  const [tab,setTab] = useState<'explain'|'phantom'|'solflare'>('explain');
  const [open,setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Got a Pump.fun token?</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto" data-pump-import-help="true">
      <DialogHeader><DialogTitle>Verify your Pump.fun project wallet</DialogTitle><DialogDescription>Why the wallet may be different, and your optional wallet-import guides.</DialogDescription></DialogHeader>
      {expectedCreator?<div className="rounded border p-3 text-sm"><strong>Recorded creator wallet</strong><p className="mt-1 break-all font-mono text-xs">{expectedCreator}</p></div>:null}
      <div className="flex flex-wrap gap-2" aria-label="Wallet guide">
        {(['explain','phantom','solflare'] as const).map(t=><Button key={t} type="button" size="sm" variant={tab===t?'default':'outline'} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='explain'?'Why this check?':`${t==='phantom'?'Phantom':'Solflare'} guide`}</Button>)}
      </div>
      {tab==='explain'?<div className="space-y-3 text-sm">
        <p>Pump.fun may have created a separate wallet when you signed up. It can be different from the Phantom or Solflare wallet you normally use. We verify the project wallet to protect your project from being claimed by someone else.</p>
        <p><strong>Still bonding?</strong> Finish graduation first. A new bonding token cannot be imported for our post-grad system.</p>
        <p><strong>Fee sharing?</strong> That creator record can point to an automated program account. It has no private key to import. We show the connected wallet's project relationships for manual review instead.</p>
        <p>Importing a personal wallet is optional. We still require a signed verification message, eligible market status and the relevant safety checks. Wallet control alone does not approve a token or unlock Battles/trading.</p>
      </div>:<div className="space-y-3 text-sm">
        <p className="rounded border border-amber-400/40 p-3"><strong>Never paste a private key or recovery phrase into MemeWarzone, a chat, or a support form.</strong> Use only the original Pump.fun app and the official wallet app, privately on a trusted device.</p>
        <ol className="list-decimal space-y-3 pl-5">
          <li>Open the original Pump.fun account and compare its <strong>full wallet address</strong> with the creator address we identified. Do not export a different account.</li>
          <li>Follow Pump.fun's official export instructions. On its mobile app: Profile, menu, Settings, Export Wallet. Privy accounts export a private key. Interface wording can vary by device.</li>
          <li>{tab==='phantom'?'In the Phantom extension, open the account menu, Add Account, Import Private Key, then choose Solana.':'In Solflare mobile, open the account selector, Add wallet, Import existing wallet, then Private key.'} Enter the key <strong>only inside that official wallet app</strong>. Never use a website key-conversion tool.</li>
          <li>Select the imported account. Verify the full address again; a watch-only account cannot sign.</li>
          <li>Return here, connect that account, then press IMPORT and sign the verification message. No verification transfer is required.</li>
        </ol>
        <div className="flex flex-wrap gap-4"><a href={GUIDES.pump} target="_blank" rel="noopener noreferrer" className="underline">Official Pump.fun instructions</a><a href={GUIDES[tab]} target="_blank" rel="noopener noreferrer" className="underline">Official {tab==='phantom'?'Phantom':'Solflare'} instructions</a></div>
      </div>}
      <Button type="button" disabled={disabled} onClick={()=>{setOpen(false);onConnect();}}>I have the correct wallet - connect</Button>
    </DialogContent>
  </Dialog>;
}
