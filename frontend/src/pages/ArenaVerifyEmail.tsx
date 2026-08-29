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
      <section className="mwz-hud-frame p-5">
        <h1 className="font-retro text-2xl text-foreground">Warzone email</h1>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        <div className="mt-4">
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to={status === "ok" ? "/command/settings" : "/warzone"}>Continue</Link>
          </Button>
        </div>
      </section>
    </ContentContainer>
  );
};

export default ArenaVerifyEmail;
