import test from "node:test";
import assert from "node:assert/strict";
import { relabelActorTitle } from "./prepare-notifications.js";

test("swaps the leading actor name for the current one", () => {
  assert.equal(relabelActorTitle("7ZkE…zohv followed you", "@derpy"), "@derpy followed you");
  assert.equal(relabelActorTitle("7ZkE...zohv replied to your post", "Derpy"), "Derpy replied to your post");
  assert.equal(relabelActorTitle("@oldname mentioned you", "@newname"), "@newname mentioned you");
  assert.equal(relabelActorTitle("0xab…cdef rocketed your post", "@evm"), "@evm rocketed your post");
});

test("leaves titles that do not start with a wallet or @name alone", () => {
  assert.equal(relabelActorTitle("Draft notifications armed", "@x"), "Draft notifications armed");
  assert.equal(relabelActorTitle("$CAT is live", "@x"), "$CAT is live");
  assert.equal(relabelActorTitle("7ZkE…zohv followed you", ""), "7ZkE…zohv followed you");
});
