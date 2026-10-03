import { useState } from "react";
import { toast } from "sonner";
import { EyeOff, Flag, MoreHorizontal, UserX } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ReportDialog, type ReportTarget } from "@/components/moderation/ReportDialog";
import { moderationKey, useModeration, type HiddenItemType } from "@/hooks/useModeration";

/**
 * "…" menu top-right on every post and comment, and on profiles (CO-30, founder 2026-10-03):
 * Report, Hide (this post/comment, only for you), Block / Unblock the author. Blocking only hides
 * that account's posts and comments for you; coin pages and trading stay as they are. Nothing shows
 * for your own content.
 */
export function ItemMenu({
  report,
  hide,
  author,
  authorLabel,
  className = "",
}: {
  report: ReportTarget;
  hide?: { type: HiddenItemType; id: string | number };
  author?: string | null;
  authorLabel?: string | null;
  className?: string;
}) {
  const moderation = useModeration();
  const [reportOpen, setReportOpen] = useState(false);
  const own = Boolean(author && moderation.account && moderationKey(author) === moderationKey(moderation.account));
  if (own) return null;
  const blocked = author ? moderation.isBlocked(author) : false;
  const who = authorLabel || "this account";

  const run = async (fn: () => Promise<void>, done: string) => {
    try {
      await fn();
      toast.success(done);
    } catch (error) {
      const msg = String((error as Error)?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled." : msg || "Something went wrong.");
    }
  };

  const item = "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[15px] text-mw-text focus:bg-mw-raised";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More options"
          onClick={(event) => event.stopPropagation()}
          className={`mw-focus inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-mw-muted hover:bg-mw-raised hover:text-mw-text ${className}`}
          data-item-menu="true"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 rounded-[14px] border border-mw-edge bg-mw-surface p-1 font-mw-body text-mw-text" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem className={item} onSelect={() => setReportOpen(true)}>
            <Flag className="h-4 w-4 text-mw-muted" aria-hidden="true" />
            {report.entityType === "profile" ? "Report profile" : report.subject === "Reported comment" ? "Report comment" : "Report post"}
          </DropdownMenuItem>
          {hide ? (
            <DropdownMenuItem className={item} onSelect={() => void run(() => moderation.hide(hide.type, hide.id), "Hidden. Only you no longer see it.")}>
              <EyeOff className="h-4 w-4 text-mw-muted" aria-hidden="true" />
              {hide.type === "comment" || hide.type === "battle_comment" ? "Hide comment" : "Hide post"}
            </DropdownMenuItem>
          ) : null}
          {author ? (
            blocked ? (
              <DropdownMenuItem className={item} onSelect={() => void run(() => moderation.unblock(author), `Unblocked ${who}`)}>
                <UserX className="h-4 w-4 text-mw-muted" aria-hidden="true" />
                Unblock {who}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className={`${item} text-mw-sell`} onSelect={() => void run(() => moderation.block(author), `Blocked ${who}. Their posts and comments are hidden for you.`)}>
                <UserX className="h-4 w-4" aria-hidden="true" />
                Block {who}
              </DropdownMenuItem>
            )
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} target={report} />
    </>
  );
}
