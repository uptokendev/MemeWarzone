export function AbuseFiledNotice({
  reportId,
  justFiled = false,
  status,
}: {
  reportId: string;
  justFiled?: boolean;
  status?: string;
}) {
  const waiting = !status || status === "OPEN" || status === "UNDER_REVIEW" || status === "WAITING_FOR_REPORTER";
  if (!justFiled && !waiting) return null;

  return (
    <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4">
      <div className="font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-accent-soft">
        {justFiled ? "Report sent" : "Abuse department"}
      </div>
      <p className="mt-2 text-sm leading-6 text-mw-text">
        Report <span className="font-mono text-mw-accent-soft">{reportId}</span>
        {justFiled ? " is filed." : " is with the Abuse department."}
        {" "}
        Stand by for their response in this Command Center file. Email is only a ping — do not follow up in Discord.
      </p>
    </div>
  );
}
