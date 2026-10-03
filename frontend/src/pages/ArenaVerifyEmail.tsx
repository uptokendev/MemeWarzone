import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { verifyArenaNotificationEmail } from "@/features/postgrad/apiClient";

const ArenaVerifyEmail = () => {
  const [params] = useSearchParams();
  const token = String(params.get("token") || "").trim();
  const [status, setStatus] = useState<"working" | "ok" | "error">(token ? "working" : "error");
  const [message, setMessage] = useState(token ? "Verifying..." : "Missing verification token.");

  useEffect(() => {
    if (!token) return;
    verifyArenaNotificationEmail(token)
      .then(() => {
        setStatus("ok");
        setMessage("Email verified. Incoming Arena challenges can now copy to this inbox.");
      })
      .catch((error) => {
        setStatus("error");
        setMessage(String((error as Error)?.message || "This verification link is invalid or expired."));
      });
  }, [token]);

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="rounded-[14px] border border-mw-border bg-mw-surface p-4 font-mw-body sm:p-5">
        <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Notifications</div>
        <h1 className="m-0 mt-2 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">Warzone email</h1>
        <p className={`mt-3 text-[15px] ${status === "ok" ? "text-[#6EE7A0]" : status === "error" ? "text-mw-sell" : "text-mw-muted"}`}>{message}</p>
        <div className="mt-4">
          <Button asChild size="sm" variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]">
            <Link to={status === "ok" ? "/command/settings" : "/warzone"}>Continue</Link>
          </Button>
        </div>
      </section>
    </ContentContainer>
  );
};

export default ArenaVerifyEmail;
