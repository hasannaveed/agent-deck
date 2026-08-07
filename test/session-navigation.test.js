import assert from "node:assert/strict";
import test from "node:test";
import { sessionNavigationCommand } from "../web/session-navigation.js";

test("GUI arrows select and wrap through visible sessions", () => {
  assert.deepEqual(sessionNavigationCommand("ArrowDown", -1, 3), { action: "select", index: 0 });
  assert.deepEqual(sessionNavigationCommand("ArrowUp", -1, 3), { action: "select", index: 2 });
  assert.deepEqual(sessionNavigationCommand("ArrowDown", 2, 3), { action: "select", index: 0 });
  assert.deepEqual(sessionNavigationCommand("ArrowUp", 0, 3), { action: "select", index: 2 });
  assert.deepEqual(sessionNavigationCommand("j", 0, 3), { action: "select", index: 1 });
  assert.deepEqual(sessionNavigationCommand("k", 1, 3), { action: "select", index: 0 });
});

test("GUI Enter activates only a selected visible session", () => {
  assert.deepEqual(sessionNavigationCommand("Enter", 1, 3), { action: "activate", index: 1 });
  assert.equal(sessionNavigationCommand("Enter", -1, 3), null);
  assert.equal(sessionNavigationCommand("Enter", 3, 3), null);
  assert.equal(sessionNavigationCommand("ArrowDown", -1, 0), null);
});
