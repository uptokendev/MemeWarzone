import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { Button } from "@/components/ui/button";
import { useAbuseReporterSession } from "@/hooks/useAbuseReporterSession";
import { listAbuseReports, type AbuseReportSummary } from "@/lib/abuseApi";

function formatWhen(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function CommandCenterAbuseReports({ embedded = false }: { embedded?: boolean }) {
  const { walletAddress, chainId } = useCommandCenterData();
  const { busy, withSession } = useAbuseReporterSession(walletAddress, chainId);
  const base = `/profile/${walletAddress}/command/support`;
  const [reports, setReports] = useState<AbuseReportSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void withSession((token) => listAbuseReports(token))
      .then((rows) => {
        if (!cancelled) setReports(rows);
      })
      .catch(() => {
        if (!cancelled) toast.error("We couldn’t load your abuse reports. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [withSession]);

  return (
    <div className="space-y-4">
      {embedded ? null : (
        <CommandCenterPageHeader
          eyebrow="Support & Safety"
          title="My Abuse Reports"
          description="Private cases filed from this wallet. Staff replies appear here, not in email or Discord."
        >
          <Button asChild className="font-semibold">
            <Link to={`${base}/report`}>New report</Link>
          </Button>
        </CommandCenterPageHeader>
      )}

      <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4">
        <div className="font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-accent-soft">Abuse department</div>
        <p className="mt-2 text-sm leading-6 text-mw-text">
          After you file a report, its case number appears here. Open a report to view updates and staff replies.
          Email only notifies you when something changes; the conversation stays in Command Center.
        </p>
      </div>

      <CommandCenterCard>
        {loading || busy ? (
          <p className="text-sm text-mw-muted">Loading your abuse file...</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-mw-muted">No abuse reports from this wallet yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                <tr>
                  <th className="pb-3 pr-4">ID</th>
                  <th className="pb-3 pr-4">Type</th>
                  <th className="pb-3 pr-4">Submitted</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id} className="border-t border-border/40">
                    <td className="py-3 pr-4">
                      <Link to={`${base}/reports/${report.id}`} className="font-semibold text-mw-accent-soft hover:underline">
                        {report.id}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-mw-text">{report.categoryLabel}</td>
                    <td className="py-3 pr-4 text-mw-muted">{formatWhen(report.createdAt)}</td>
                    <td className="py-3 pr-4 text-mw-text">{report.statusLabel}</td>
                    <td className="py-3 text-mw-muted">{formatWhen(report.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CommandCenterCard>
    </div>
  );
}
