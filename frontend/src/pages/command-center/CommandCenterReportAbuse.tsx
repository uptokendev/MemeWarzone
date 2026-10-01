import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAbuseReporterSession } from "@/hooks/useAbuseReporterSession";
import { createAbuseReport, uploadAbuseEvidence, type AbuseCategory, type AbuseEntityType } from "@/lib/abuseApi";

const CATEGORIES: { value: AbuseCategory; label: string }[] = [
  { value: "impersonation", label: "Someone is impersonating me" },
  { value: "stolen_content", label: "Someone is using my images/content" },
  { value: "fake_project", label: "A fake project/token is pretending to represent me" },
  { value: "phishing", label: "Phishing/scam impersonation" },
  { value: "other", label: "Other abuse" },
];

const ENTITIES: { value: AbuseEntityType | ""; label: string }[] = [
  { value: "", label: "Select if you have one" },
  { value: "profile", label: "MemeWarzone user/profile" },
  { value: "campaign", label: "Campaign" },
  { value: "token", label: "Token" },
  { value: "wallet", label: "Wallet" },
  { value: "external_account", label: "External account" },
  { value: "external_website", label: "External website" },
  { value: "other", label: "Other" },
];

const fieldClass = "border-border/60 bg-background/40 font-sans";

export default function CommandCenterReportAbuse({ embedded = false }: { embedded?: boolean }) {
  const { walletAddress, chainId } = useCommandCenterData();
  const { busy, withSession } = useAbuseReporterSession(walletAddress, chainId);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const base = `/profile/${walletAddress}/command/support`;
  const [filedId, setFiledId] = useState("");

  const [category, setCategory] = useState<AbuseCategory | "">((searchParams.get("category") as AbuseCategory) || "");
  const [entityType, setEntityType] = useState<AbuseEntityType | "">((searchParams.get("entity") as AbuseEntityType) || "");
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [reportedWallet, setReportedWallet] = useState(searchParams.get("wallet") || "");
  const [reportedCampaignAddress, setReportedCampaignAddress] = useState(searchParams.get("campaign") || "");
  const [reportedTokenAddress, setReportedTokenAddress] = useState(searchParams.get("token") || "");
  const [reportedUrl, setReportedUrl] = useState(searchParams.get("url") || "");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!category) {
      toast.error("Choose an abuse category.");
      return;
    }
    setSubmitting(true);
    try {
      const report = await withSession((token) => createAbuseReport(token, {
        category,
        email,
        description,
        entityType,
        reportedWallet,
        reportedCampaignAddress,
        reportedTokenAddress,
        reportedUrl,
      }));
      for (const file of files.slice(0, 5)) {
        await withSession((token) => uploadAbuseEvidence(token, report.id, file));
      }
      toast.success(`Report ${report.id} submitted. Updates and staff replies will appear in your Command Center.`);
      if (embedded) setFiledId(report.id);
      else navigate(`${base}/reports/${report.id}?filed=1`);
    } catch (error) {
      const existingId = String((error as Error & { reportId?: string })?.reportId || "").trim();
      toast.error("We couldn’t submit your report. Please try again.");
      if (existingId) navigate(`${base}/reports/${existingId}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (embedded && filedId) {
    return (
      <CommandCenterCard eyebrow="Report submitted" title={filedId}>
        <p className="text-sm leading-6 text-muted-foreground">
          Your report has been submitted. Updates and staff replies will appear here. Email is only used to notify you when something changes.
        </p>
        <Button asChild className="mt-4 font-retro">
          <Link to={`${base}/reports/${filedId}?filed=1`}>View case file</Link>
        </Button>
      </CommandCenterCard>
    );
  }

  return (
    <div className="space-y-4">
      {embedded ? null : (
        <CommandCenterPageHeader
          eyebrow="Support & Safety"
          title="Report Abuse"
          description="Use this form only for impersonation, identity theft, stolen images or branding, fake official profiles, and phishing that pretends to represent you or MemeWarzone."
        />
      )}

      <CommandCenterCard title="This is not Discord support">
        <p className="text-sm leading-6 text-muted-foreground">
          Wallet problems, failed transactions, rewards, product questions and feature requests stay in Discord.
          Abuse reports stay inside Command Center. Email is only used to tell you when staff replies.
        </p>
      </CommandCenterCard>

      <form onSubmit={handleSubmit} className="space-y-4">
        <CommandCenterCard title="Report form">
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="abuse-category">Category</Label>
              <select
                id="abuse-category"
                required
                value={category}
                onChange={(event) => setCategory(event.target.value as AbuseCategory)}
                className="flex h-10 w-full rounded-md border border-border/60 bg-background/40 px-3 text-sm"
              >
                <option value="">Select category</option>
                {CATEGORIES.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="abuse-entity">Reported entity</Label>
              <select
                id="abuse-entity"
                value={entityType}
                onChange={(event) => setEntityType(event.target.value as AbuseEntityType | "")}
                className="flex h-10 w-full rounded-md border border-border/60 bg-background/40 px-3 text-sm"
              >
                {ENTITIES.map((item) => (
                  <option key={item.value || "none"} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="abuse-url">Profile / page URL</Label>
                <Input id="abuse-url" className={fieldClass} value={reportedUrl} onChange={(event) => setReportedUrl(event.target.value)} placeholder="https://" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="abuse-wallet">Wallet address</Label>
                <Input id="abuse-wallet" className={fieldClass} value={reportedWallet} onChange={(event) => setReportedWallet(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="abuse-campaign">Campaign address</Label>
                <Input id="abuse-campaign" className={fieldClass} value={reportedCampaignAddress} onChange={(event) => setReportedCampaignAddress(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="abuse-token">Token address / mint</Label>
                <Input id="abuse-token" className={fieldClass} value={reportedTokenAddress} onChange={(event) => setReportedTokenAddress(event.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="abuse-description">Description</Label>
              <Textarea
                id="abuse-description"
                required
                minLength={20}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className={`${fieldClass} min-h-32`}
                placeholder="What happened, where, and how it targets you."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="abuse-email">Email</Label>
              <Input
                id="abuse-email"
                type="email"
                required
                className={fieldClass}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                MemeWarzone uses this address only to notify you when your report is updated. The conversation stays inside Command Center.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="abuse-evidence">Evidence</Label>
              <Input
                id="abuse-evidence"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className={fieldClass}
                onChange={(event) => setFiles(Array.from(event.target.files || []).slice(0, 5))}
              />
              <p className="text-xs text-muted-foreground">JPG, PNG, WEBP or PDF. Max 5 files, 10 MB each.</p>
            </div>
          </div>
        </CommandCenterCard>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="font-retro" disabled={submitting || busy}>
            {submitting || busy ? "Signing / filing..." : "Submit abuse report"}
          </Button>
          {embedded ? null : (
            <Button type="button" variant="outline" className="font-retro" asChild>
              <Link to={base}>Back to Help</Link>
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
