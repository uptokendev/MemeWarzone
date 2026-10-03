import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui-v2";
import { useFeedSession } from "@/hooks/useFeedSession";
import { createInAppAbuseReport } from "@/lib/abuseApi";

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
  // Runs on the feed session (founder, 2026-10-03): the one signature per 30 days that covers posting.
  const { account, withSession } = useFeedSession();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

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
      await withSession((token) => createInAppAbuseReport(token, input));
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
