import assert from "node:assert/strict";
import test from "node:test";

import { rankFeedPosts, scoreFeedPost } from "./feedRanking.js";

test("recency outranks a pile of fires", () => {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString();
  const fresh = scoreFeedPost({ createdAt: now, fireCount: 0 });
  const oldHot = scoreFeedPost({ createdAt: yesterday, fireCount: 80 });
  assert.ok(fresh > oldHot, `fresh ${fresh} should beat old-hot ${oldHot}`);
});

test("following an author is a bigger boost than a few fires", () => {
  const now = new Date().toISOString();
  const followed = scoreFeedPost({ createdAt: now, fireCount: 0, followed: true });
  const unfollowed = scoreFeedPost({ createdAt: now, fireCount: 8, followed: false });
  assert.ok(followed > unfollowed);
});

test("rankFeedPosts puts followed authors first among equally fresh posts", () => {
  const now = new Date().toISOString();
  const ranked = rankFeedPosts(
    [
      { postId: 1, wallet: "0xaaa", createdAt: now, fireCount: 12 },
      { postId: 2, wallet: "0xbbb", createdAt: now, fireCount: 0 },
    ],
    { following: ["0xBBB"], limit: 10 },
  );
  assert.equal(ranked[0].postId, 2);
});
