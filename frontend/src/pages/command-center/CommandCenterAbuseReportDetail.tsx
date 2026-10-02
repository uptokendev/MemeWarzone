import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAbuseReporterSession } from "@/hooks/useAbuseReporterSession";
import { AbuseFiledNotice } from "@/components/command-center/AbuseFiledNotice";
import {
  getAbuseReport,
  replyToAbuseReport,
  uploadAbuseEvidence,
  type AbuseReportDetail,
} from "@/lib/abuseApi";

function formatWhen(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function CommandCenterAbuseReportDetail() {
  const { reportId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const justFiled = searchParams.get("filed") === "1";
  const { walletAddress, chainId } = useCommandCenterData();
  const { withSession } = useAbuseReporterSession(walletAddress, chainId);
  const base = `/profile/${walletAddress}/command/support`;
  const [report, setReport] = useState<AbuseReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);

  const closed = report?.status === "CLOSED";

  const load = useMemo(() => async () => {
    const detail = await withSession((token) => getAbuseReport(token, reportId));
    setReport(detail);
  }, [reportId, withSession]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .catch((error) => {
        if (!cancelled) toast.error(String((error as Error)?.message || "Could not open this report."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleReply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!report) return;
    setSending(true);
    try {
      if (reply.trim()) {
        await withSession((token) => replyToAbuseReport(token, report.id, reply));
      }
      for (const file of files.slice(0, 5)) {
        await withSession((token) => uploadAbuseEvidence(token, report.id, file));
      }
      setReply("");
      setFiles([]);
      await load();
      toast.success("Reply posted inside Command Center.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send that reply."));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <CommandCenterPageHeader
        eyebrow="Support & Safety"
        title={report?.id || "Abuse report"}
        description={report ? `${report.categoryLabel} · ${report.statusLabel}` : "Private abuse conversation"}
      >
        <Button asChild variant="outline" className="font-semibold">
          <Link to={`${base}/reports`}>All reports</Link>
        </Button>
      </CommandCenterPageHeader>

      {loading ? (
        <CommandCenterCard>
          <p className="text-sm text-mw-muted">Opening the case file...</p>
        </CommandCenterCard>
      ) : !report ? (
        <CommandCenterCard>
          <p className="text-sm text-mw-muted">This report is not visible to this wallet.</p>
        </CommandCenterCard>
      ) : (
        <>
          <AbuseFiledNotice reportId={report.id} justFiled={justFiled} status={report.status} />

          <CommandCenterCard title="Case facts">
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              <div>
                <dt className="text-mw-muted">Reported wallet</dt>
                <dd className="break-all font-mono text-xs">{report.reportedWallet || "—"}</dd>
              </div>
              <div>
                <dt className="text-mw-muted">Campaign / token</dt>
                <dd className="break-all font-mono text-xs">{report.reportedCampaignAddress || report.reportedTokenAddress || "—"}</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="text-mw-muted">URL</dt>
                <dd className="break-all">{report.reportedUrl || "—"}</dd>
              </div>
            </dl>
          </CommandCenterCard>

          <CommandCenterCard title="Conversation">
            <div className="space-y-3">
              {report.messages.map((message) => (
                <div
                  key={message.id}
                  className={`rounded-2xl border p-4 ${
                    message.senderType === "admin"
                      ? "border-accent/40 bg-accent/5"
                      : "border-border/50 bg-background/25"
                  }`}
                >
                  <div className="mb-2 font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                    {message.senderType === "admin" ? "Abuse desk" : "You"} · {formatWhen(message.createdAt)}
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-6 text-mw-text">{message.message}</p>
                  {report.evidence.filter((item) => item.messageId === message.id).map((item) => (
                    <div key={item.id} className="mt-2 text-xs text-mw-muted">
                      Evidence: {item.originalFilename}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </CommandCenterCard>

          <CommandCenterCard title={closed ? "Case closed" : "Reply"}>
            {closed ? (
              <p className="text-sm text-mw-muted">This case is administratively finished.</p>
            ) : (
              <form onSubmit={handleReply} className="space-y-3">
                <Textarea
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  className="min-h-28 border-border/60 bg-background/40 font-sans"
                  placeholder="Reply stays inside Command Center."
                />
                <input
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(event) => setFiles(Array.from(event.target.files || []).slice(0, 5))}
                />
                <Button type="submit" className="font-semibold" disabled={sending || (!reply.trim() && files.length === 0)}>
                  {sending ? "Sending..." : "Send reply"}
                </Button>
              </form>
            )}
          </CommandCenterCard>
        </>
      )}
    </div>
  );
}
