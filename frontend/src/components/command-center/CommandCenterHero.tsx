import { Copy, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";

function shortenWallet(addr?: string | null) {
  if (!addr) return "";
  return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

type CommandCenterHeroProps = {
  walletAddress: string;
};

export function CommandCenterHero({ walletAddress }: CommandCenterHeroProps) {
  const {
    displayName,
    avatarUrl,
    followersCount,
    followingCount,
    createdCount,
    draftCount,
    loadingFollows,
    loadingDraftCount,
  } = useCommandCenterData();

  const short = shortenWallet(walletAddress);
  const publicProfileBase = `/profile/${encodeURIComponent(walletAddress)}`;
  const commandBase = `${publicProfileBase}/command`;

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy address");
    }
  };

  const stats: Array<{ to: string; value: string | number; label: string }> = [
    { to: `${commandBase}/coins`, value: createdCount, label: Number(createdCount) === 1 ? "coin" : "coins" },
    { to: `${commandBase}/coins`, value: loadingDraftCount ? "..." : draftCount, label: Number(draftCount) === 1 ? "draft" : "drafts" },
    { to: `${commandBase}/followers`, value: loadingFollows ? "..." : followersCount, label: "followers" },
    { to: `${commandBase}/following`, value: loadingFollows ? "..." : followingCount, label: "following" },
  ];

  return (
    <section className="flex flex-col gap-3 font-mw-body text-mw-text lg:flex-row lg:items-center lg:gap-[18px] lg:rounded-[14px] lg:border lg:border-mw-border lg:bg-mw-surface lg:p-5">
      <div className="flex min-w-0 flex-1 items-center gap-3 lg:gap-[18px]">
        <img src={avatarUrl} alt="" className="h-[52px] w-[52px] shrink-0 rounded-full border border-mw-border object-cover lg:h-[72px] lg:w-[72px]" />
        <div className="min-w-0 flex-1">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Your profile</div>
          <h1 className="m-0 truncate font-mw-cond text-xl font-bold leading-tight lg:text-[30px]">{displayName || short || "Connected wallet"}</h1>
          <div className="mt-0.5 hidden items-center gap-2 font-mw-mono text-[13px] text-mw-muted sm:flex">
            <span className="truncate">{short} · only you see this</span>
            <button
              type="button"
              onClick={handleCopyAddress}
              aria-label="Copy wallet address"
              className="mw-focus inline-flex h-6 items-center gap-1 rounded-full border border-mw-edge bg-mw-raised px-2 font-mw-body text-xs font-semibold text-mw-text"
            >
              <Copy className="h-3 w-3" aria-hidden="true" />
              Copy
            </button>
          </div>
        </div>
        <Link
          to={publicProfileBase}
          className="mw-focus inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text lg:hidden"
        >
          Profile
        </Link>
      </div>
      <div className="-mx-3 flex gap-4 overflow-x-auto whitespace-nowrap px-3 text-sm [scrollbar-width:none] lg:mx-0 lg:gap-[22px] lg:px-0 lg:text-[15px] [&::-webkit-scrollbar]:hidden">
        {stats.map((stat) => (
          <Link key={stat.label} to={stat.to} className="mw-focus rounded-md text-mw-text hover:text-mw-text">
            <b>{stat.value}</b> <span className="text-mw-muted">{stat.label}</span>
          </Link>
        ))}
      </div>
      <Link
        to={publicProfileBase}
        className="mw-focus hidden min-h-11 shrink-0 items-center gap-1.5 rounded-[10px] border border-mw-edge bg-mw-raised px-[18px] text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text lg:inline-flex"
      >
        Public profile
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </Link>
    </section>
  );
}
