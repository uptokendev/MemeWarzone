import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import {
  NOT_PREVIEWED_EXPLANATION,
  NOT_PREVIEWED_LABEL,
  OPEN_WAR_EXPLANATION,
  OPEN_WAR_LABEL,
} from "@/lib/arena/findMatchPresentation.mjs";

export type MatchQualityPreviewModel = {
  tokenId?: string;
  matchQualityLabel?: string | null;
  classificationLabel?: string;
  ranked?: boolean | null;
  previewKind?: "ranked" | "open_war" | "not_previewed";
  challengeAnyway?: boolean;
  continueWithChallenge?: boolean;
  explanation?: string;
  source?: string;
};

type MatchQualityPreviewProps = {
  preview: MatchQualityPreviewModel | null;
  onChallengeAnyway?: () => void;
  onContinueWithChallenge?: () => void;
};

export function MatchQualityPreview({
  preview,
  onChallengeAnyway,
  onContinueWithChallenge,
}: MatchQualityPreviewProps) {
  if (!preview?.tokenId) return null;

  if (preview.previewKind === "not_previewed" || preview.ranked == null) {
    return (
      <div className="mwz-hud-frame space-y-3 p-3" data-match-quality="not-previewed">
        <TacticalTag label={NOT_PREVIEWED_LABEL} tone="default" />
        <p className="text-sm text-muted-foreground">{preview.explanation || NOT_PREVIEWED_EXPLANATION}</p>
        {onContinueWithChallenge ? (
          <Button type="button" size="sm" variant="outline" className="font-retro" onClick={onContinueWithChallenge}>
            Continue with challenge
          </Button>
        ) : null}
      </div>
    );
  }

  if (preview.previewKind === "open_war" || preview.ranked === false) {
    return (
      <div className="mwz-hud-frame space-y-3 p-3" data-match-quality="open-war">
        <TacticalTag label={OPEN_WAR_LABEL} tone="hot" />
        <p className="text-sm text-muted-foreground">{preview.explanation || OPEN_WAR_EXPLANATION}</p>
        {onChallengeAnyway ? (
          <Button type="button" size="sm" variant="outline" className="font-retro" onClick={onChallengeAnyway}>
            Challenge anyway
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mwz-hud-frame space-y-2 p-3" data-match-quality="ranked">
      <div className="flex flex-wrap items-center gap-2">
        <TacticalTag label={preview.classificationLabel || "Match"} tone="success" />
        <TacticalTag label="Ranked" tone="sponsored" />
      </div>
      {preview.matchQualityLabel ? (
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Match Quality</div>
          <div className="font-retro text-lg text-foreground">{preview.matchQualityLabel}</div>
        </div>
      ) : null}
    </div>
  );
}
