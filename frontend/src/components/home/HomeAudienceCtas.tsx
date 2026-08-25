import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWallet } from "@/contexts/WalletContext";
import { analytics } from "@/lib/analytics/ProductAnalytics";
import creatorBg from "@/assets/home/cta-creators-bg.png";
import creatorSoldier from "@/assets/home/cta-creator-soldier.png";

// Public static assets (moved out of src for easier editing/cropping)
const recruiterBg = "/assets/home/cta-recruiters-bg.png";
const recruiterSoldier = "/assets/home/cta-recruiter-soldier.png";

const CREATE_DRAFT_PATH = "/create";

type AudienceCardProps = {
  tone: "creator" | "recruiter";
  title: string;
  kicker: string;
  body: string;
  buttonLabel: string;
  footer: string;
  bg: string;
  soldier: string;
  onClick: () => void;
  size?: "default" | "sm";
  className?: string;
};

export function AudienceCard({
  tone,
  title,
  kicker,
  body,
  buttonLabel,
  footer,
  bg,
  soldier,
  onClick,
  size = "default",
  className,
}: AudienceCardProps) {
  const isCreator = tone === "creator";
  const isSmall = size === "sm";

  return (
    <article
      className={cn(
        "relative isolate w-full overflow-visible",
        !isSmall && "h-[200px] sm:h-[200px] lg:h-[200px] 2xl:h-[200px]",
        isSmall && "min-h-[200px] sm:min-h-[200px] lg:min-h-[200px]",  // fallback; h-full from className wins for stretch alignment
        "bg-transparent border-0 shadow-none",
        className
      )}
    >
      {/* Background art: stretched to fully fill the card */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-transparent">
        <img
          src={bg}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="h-full w-full select-none object-fill"
        />
      </div>

      {/* Text block */}
<div
  className={cn(
    "absolute z-30",
    isSmall 
      ? "top-[16%] left-[5%] w-[72%] sm:left-[6%] sm:w-[72%]"   // bigger text block
      : "top-[8%] sm:top-[9%] lg:top-[10%] 2xl:top-[8%]",
    !isSmall && (isCreator
      ? "left-[7%] w-[74%] sm:left-[8%] sm:w-[66%] lg:left-[12%] lg:w-[42%]"
      : "left-[7%] w-[74%] sm:left-[8%] sm:w-[66%] lg:left-[12%] lg:w-[42%]")
  )}
>
        <h2
          className={cn(
            "font-black uppercase leading-[0.98] tracking-[0.045em] whitespace-nowrap text-white drop-shadow-[0_3px_10px_rgba(0,0,0,0.9)]",
            isSmall 
              ? "text-[16px] sm:text-[17px] lg:text-[18px]" 
              : "text-[26px] sm:text-[29px] md:text-[31px] 2xl:text-[34px]"
          )}
        >
          {title}
        </h2>

        <p
          className={cn(
            "mt-1.5 max-w-[430px] font-extrabold leading-[1.12]",
            isCreator ? "text-[#5cff22]" : "text-[#ff981f]",
            isSmall 
              ? "text-[10px] sm:text-[10.5px] lg:text-[11px]" 
              : "mt-3 text-[13px] sm:text-[15px] md:text-[16px] 2xl:text-[18px]"
          )}
        >
          {kicker}
        </p>

        <p
          className={cn(
            "mt-1 max-w-[430px] font-semibold leading-[1.32] text-white/88 drop-shadow-[0_2px_8px_rgba(0,0,0,0.85)]",
            isSmall 
              ? "text-[9px] sm:text-[9.5px] lg:text-[10px]" 
              : "mt-3 text-[11px] sm:text-[12px] md:text-[13px] 2xl:text-[14px]"
          )}
        >
          {body}
        </p>

        <Button
          type="button"
          onClick={onClick}
          style={{
            clipPath:
              "polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)",
          }}
          className={cn(
            isSmall ? "mt-2 h-8 min-w-[140px] px-3 text-[9px]" : "mt-4 md:mt-5 h-[38px] sm:h-[40px] md:h-[42px] 2xl:h-[44px] min-w-[210px] sm:min-w-[245px] md:min-w-[270px] 2xl:min-w-[285px] px-5 md:px-7 text-[10px] sm:text-[11px] md:text-[12px] 2xl:text-[13px]",
            "rounded-none border font-black uppercase tracking-[0.08em] shadow-[0_0_18px_rgba(0,0,0,0.7)] flex items-center justify-center gap-2",
            isCreator
              ? "border-[#75ff2d]/75 bg-gradient-to-b from-[#24bd00] to-[#126900] text-white hover:from-[#35d900] hover:to-[#168000]"
              : "border-[#ff9a22]/75 bg-gradient-to-b from-[#df780d] to-[#9b3e05] text-white hover:from-[#ff8d15] hover:to-[#b84907]"
          )}
        >
          <span>{buttonLabel}</span>
          <ChevronRight className={cn(isSmall ? "h-3.5 w-3.5" : "h-4 w-4")} />
        </Button>

        <div
          className={cn(
            isSmall ? "mt-1.5 w-[140px] text-[8px]" : "mt-3 md:mt-4 w-[210px] sm:w-[245px] md:w-[270px] 2xl:w-[285px] text-[9px] sm:text-[10px] md:text-[11px] 2xl:text-[12px]",
            "text-center whitespace-nowrap font-black uppercase tracking-[0.32em]",
            isCreator ? "text-[#4df313]" : "text-[#ff9a22]"
          )}
        >
          {footer}
        </div>
      </div>

      {/* Soldier art: smaller, shifted right, bottom-aligned */}
<img
  src={soldier}
  alt=""
  aria-hidden="true"
  draggable={false}
  className={cn(
    "pointer-events-none absolute bottom-0 z-20 select-none object-contain max-w-none",
    isSmall && "scale-[0.90] origin-bottom-right",
    isCreator
      ? [
          isSmall 
            ? "right-[-10%] h-[90%] lg:right-[-4%] lg:h-[95%]" 
            : [
                "right-[-30%] h-[94%]",
                "sm:right-[-22%] sm:h-[100%]",
                "lg:right-[-6%] lg:h-[108%]",
                "2xl:right-[-5%] 2xl:h-[110%]",
              ].join(" ")
        ].join(" ")
      : [
          isSmall 
            ? "right-[3px] h-[102%] lg:right-[3px] lg:h-[103%]"   // tight to outer right edge, just a few pixels inset
            : [
                "right-[-32%] h-[98%]",
                "sm:right-[-24%] sm:h-[104%]",
                "lg:right-[-11%] lg:h-[114%]",
                "2xl:right-[-9%] 2xl:h-[116%]",
              ].join(" ")
        ].join(" ")
  )}
/>
    </article>
  );
}

export function HomeAudienceCtas() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const [pendingRecruiterRedirect, setPendingRecruiterRedirect] = useState(false);

  const recruiterPath = wallet.account
    ? `/profile/${wallet.account.toLowerCase()}/command/recruiter`
    : "";

  useEffect(() => {
    if (!pendingRecruiterRedirect || !wallet.account) return;

    setPendingRecruiterRedirect(false);
    navigate(`/profile/${wallet.account.toLowerCase()}/command/recruiter`);
  }, [pendingRecruiterRedirect, wallet.account, navigate]);

  const handleRecruiterClick = async () => {
    analytics.track("page_cta_clicked", { cta_id: "home_join_recruiter" });
    if (wallet.account) {
      navigate(recruiterPath);
      return;
    }

    setPendingRecruiterRedirect(true);

    try {
      await wallet.connect();
    } catch {
      setPendingRecruiterRedirect(false);
    }
  };

  return (
    <section
      className={cn(
        "relative z-20 grid grid-cols-1 gap-4 overflow-visible",
        "lg:grid-cols-2"
      )}
      aria-label="Creator and recruiter onboarding"
    >
      <AudienceCard
        tone="creator"
        title="For Creators"
        kicker="Launch your campaign. Build your army."
        body="Create draft memecoins, tell your story, build your community, and prepare your coin for battle inside MemeWarzone."
        buttonLabel="Create a Draft"
        footer="Launch • Build • Deploy"
        bg={creatorBg}
        soldier={creatorSoldier}
        onClick={() => {
          analytics.track("page_cta_clicked", { cta_id: "home_create_draft" });
          navigate(CREATE_DRAFT_PATH);
        }}
      />

      <AudienceCard
        tone="recruiter"
        title="Recruiters"
        kicker="We’re looking for YOU."
        body="Recruit your Squad, bring in coin creators and traders, and become the force that drives visibility, traction, and community growth."
        buttonLabel="Join as Recruiter"
        footer="Scout • Recruit • Earn"
        bg={recruiterBg}
        soldier={recruiterSoldier}
        onClick={handleRecruiterClick}
      />
    </section>
  );
}