import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui-v2";
import { useWallet } from "@/contexts/WalletContext";
import { useFeedSession } from "@/hooks/useFeedSession";
import { createAbuseReport, openAbuseSession, readStoredAbuseSession, signAbuseSession, clearAbuseSession } from "@/lib/abuseApi";
import { signSolanaMessage } from "@/lib/solanaWallet";

export type ReportTarget = {
  entityType: "post" | "profile";
  /** "Reported post", "Reported comment", "Reported profile" (subject line in the abuse desk). */
  subject: string;
  reportedWallet?: string | null;
  reportedUrl: string;
};

const MIN = 20;
const MAX = 1000;

/**
 * Quick report (CO-30, founder 2026-10-03): one textbox, sent to the existing abuse desk as an
 * in-app report. The reporter follows it in Command Center > Support.
 */
export function ReportDialog({ open, onClose, target }: { open: boolean; onClose: () => void; target: ReportTarget }) {
  const { account, chainId } = useFeedSession();
  const wallet = useWallet() as any;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function session(): Promise<string> {
    const stored = readStoredAbuseSession(account, chainId);
    if (stored) return stored;
    const solana = !account.startsWith("0x");
    const auth = await signAbuseSession({
      walletAddress: account,
      chainId,
      walletType: solana ? "solana" : "evm",
      signMessage: solana ? async (message) => (await signSolanaMessage(message, account)).signature : undefined,
      signer: solana ? undefined : wallet?.signer,
    });
    return openAbuseSession({ walletAddress: account, chainId, auth });
  }

  async function send() {
    if (!account) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
    setSending(true);
    try {
      const input = {
        category: "other" as const,
        email: "",
        description: text.trim(),
        subject: target.subject,
        entityType: target.entityType,
        reportedWallet: target.reportedWallet || "",
        reportedUrl: target.reportedUrl,
        source: "in_app" as const,
      };
      let token = await session();
      try {
        await createAbuseReport(token, input);
      } catch (error) {
        if ((error as { code?: string })?.code !== "ABUSE_SESSION_REQUIRED") throw error;
        clearAbuseSession(account, chainId);
        token = await session();
        await createAbuseReport(token, input);
      }
      toast.success("Report sent. You can follow it in Command Center > Support.");
      setText("");
      onClose();
    } catch (error) {
      const msg = String((error as Error)?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was sent." : msg || "Could not send the report.");
    } finally {
      setSending(false);
    }
  }

  const length = text.trim().length;
  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} title={target.subject.replace(/^Reported /, "Report ")} description="Tell us what is wrong. Our team reviews every report.">
      <div className="flex flex-col gap-3" data-report-dialog="true">
        <textarea
          autoFocus
          value={text}
          maxLength={MAX}
          onChange={(e) => setText(e.target.value)}
          placeholder="What is wrong with this? For example scam link, impersonation, spam."
          className="mw-focus min-h-[120px] w-full resize-none rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2.5 text-[15px] text-mw-text placeholder:text-[#5C6670]"
        />
        <div className="flex items-center justify-between text-xs text-mw-muted">
          <span>{length < MIN ? `At least ${MIN} characters` : "Ready to send"}</span>
          <span className="font-mw-mono">{text.length}/{MAX}</span>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="mw-focus inline-flex min-h-11 items-center px-4 text-[15px] font-semibold text-mw-muted hover:text-mw-text">
            Cancel
          </button>
          <button
            type="button"
            disabled={length < MIN || sending}
            onClick={() => void send()}
            className="mw-focus inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50"
          >
            {sending ? "Sending..." : "Send report"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
