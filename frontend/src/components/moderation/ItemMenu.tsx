import { useState } from "react";
import { toast } from "sonner";
import { EyeOff, Flag, MoreHorizontal, Trash2, UserX } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ReportDialog, type ReportTarget } from "@/components/moderation/ReportDialog";
import { Modal } from "@/components/ui-v2";
import { moderationKey, useModeration, type HiddenItemType } from "@/hooks/useModeration";

/**
 * "…" menu top-right on every post and comment, and on profiles (CO-30, founder 2026-10-03):
 * Report, Hide (this post/comment, only for you), Block / Unblock the author. Blocking only hides
 * that account's posts and comments for you; coin pages and trading stay as they are. On your own
 * content it shows only Delete, when the caller passes `onDelete` (founder, 2026-10-03), else nothing.
 */
export function ItemMenu({
  report,
  hide,
  author,
  authorLabel,
  className = "",
  onDelete,
}: {
  report: ReportTarget;
  hide?: { type: HiddenItemType; id: string | number };
  author?: string | null;
  authorLabel?: string | null;
  className?: string;
  /** Deletes your own post or reply. Only used on your own content. */
  onDelete?: () => Promise<void>;
}) {
  const moderation = useModeration();
  const [reportOpen, setReportOpen] = useState(false);
  const own = Boolean(author && moderation.account && moderationKey(author) === moderationKey(moderation.account));
  if (own) return onDelete ? <OwnItemMenu className={className} onDelete={onDelete} isComment={report.subject === "Reported comment"} /> : null;
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

/** "…" on your own post or reply: Delete, after a confirmation. */
function OwnItemMenu({ className, onDelete, isComment }: { className: string; onDelete: () => Promise<void>; isComment: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const noun = isComment ? "reply" : "post";
  const item = "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[15px] focus:bg-mw-raised";
  const remove = async () => {
    setBusy(true);
    try {
      await onDelete();
      setConfirm(false);
      toast.success(isComment ? "Reply deleted." : "Post deleted.");
    } catch (error) {
      const msg = String((error as Error)?.message || "");
      toast.error(/reject|denied|cancel/i.test(msg) ? "Signature cancelled. Nothing was deleted." : msg || "Could not delete.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More options"
          onClick={(event) => event.stopPropagation()}
          className={`mw-focus inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-mw-muted hover:bg-mw-raised hover:text-mw-text ${className}`}
          data-item-menu="own"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 rounded-[14px] border border-mw-edge bg-mw-surface p-1 font-mw-body text-mw-text" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem className={`${item} text-mw-sell`} onSelect={() => setConfirm(true)}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete {noun}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Modal open={confirm} onOpenChange={(next) => (next ? null : busy ? null : setConfirm(false))} title={`Delete this ${noun}?`} description={`It disappears from the feed, your profile and search. This can't be undone.`}>
        <div className="flex justify-end gap-2" data-delete-confirm="true">
          <button type="button" disabled={busy} onClick={() => setConfirm(false)} className="mw-focus inline-flex min-h-11 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text disabled:opacity-50">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => void remove()} className="mw-focus inline-flex min-h-11 items-center rounded-[10px] border border-mw-sell bg-mw-sell px-4 text-[15px] font-bold text-white disabled:opacity-50">
            {busy ? "Deleting..." : "Delete"}
          </button>
        </div>
      </Modal>
    </>
  );
}
