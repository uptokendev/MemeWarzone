import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

function readRepo(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("profile avatar is square with no orange ring", () => {
  const shell = readRepo("frontend/src/components/profile/ProfileShell.tsx");
  const avatarLine = shell.split("\n").find((line) => line.includes("data-profile-avatar"));
  assert.ok(avatarLine, "missing data-profile-avatar");
  assert.match(avatarLine, /rounded-none/);
  assert.doesNotMatch(avatarLine, /rounded-full/);
  assert.doesNotMatch(avatarLine, /border-accent/);
  assert.doesNotMatch(avatarLine, /border-4/);
});

test("public profile uses the shared shell and hides portfolio tiles", () => {
  const page = readRepo("frontend/src/pages/PublicProfile.tsx");
  assert.match(page, /<ProfileShell/);
  assert.match(page, /data-profile-page="public"/);
  assert.doesNotMatch(page, /PortfolioMetricsGrid/);
  assert.doesNotMatch(page, /RankBadgeCard/);
  assert.match(page, /tab=\{tab\}/);
});

test("command center home uses the same shell; tools keep a back bar", () => {
  const layout = readRepo("frontend/src/components/command-center/CommandCenterLayout.tsx");
  assert.match(layout, /<ProfileShell/);
  assert.match(layout, /data-profile-page="command"/);
  assert.match(layout, /data-command-back/);
  assert.doesNotMatch(layout, /CommandCenterHero/);
  assert.doesNotMatch(layout, /CommandCenterSidebar/);
});

test("owner more sheet is command-only and public visitors get Follow+", () => {
  const shell = readRepo("frontend/src/components/profile/ProfileShell.tsx");
  assert.match(shell, /data-profile-more="true"/);
  assert.match(shell, /isOwner \? \(/);
  assert.match(shell, /ProfileMoreSheet/);
  assert.match(shell, /Follow \+/);
  const more = readRepo("frontend/src/components/profile/ProfileMoreSheet.tsx");
  assert.match(more, /path: "overview"/);
  assert.match(more, /path: "settings"/);
});

test("profile posts use a rocket like, views, and live accent", () => {
  const card = readRepo("frontend/src/components/profile/ProfilePostCard.tsx");
  assert.match(card, /from "lucide-react"/);
  assert.match(card, /Rocket/);
  assert.match(card, /Eye/);
  assert.match(card, /text-accent/);
  assert.doesNotMatch(card, /Flame/);
  const timeline = readRepo("frontend/src/components/profile/ProfileTimeline.tsx");
  assert.match(timeline, /placeholder="Drop your payload"/);
  assert.match(timeline, /<ProfilePostCard/);
});

test("composer launch control stays Post and who-to-follow reuses the feed rail", () => {
  const composer = readRepo("frontend/src/components/feed/FeedComposer.tsx");
  assert.match(composer, /\{posting \? "Posting\.\.\." : "Post"\}/);
  assert.doesNotMatch(composer, />Launch</);
  const shell = readRepo("frontend/src/components/profile/ProfileShell.tsx");
  assert.match(shell, /FeedWhoToFollow/);
  assert.match(shell, /followSuggestions/);
});

test("edit profile can change cover and square photo", () => {
  const dialog = readRepo("frontend/src/components/profile/EditProfileDialog.tsx");
  assert.match(dialog, /onPickBanner/);
  assert.match(dialog, /Change cover/);
  assert.match(dialog, /rounded-none/);
  const hook = readRepo("frontend/src/hooks/profile/useEditableProfile.ts");
  assert.match(hook, /handleBannerSelected/);
  assert.match(hook, /bannerUrl/);
});
