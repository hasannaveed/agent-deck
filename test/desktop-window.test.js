import assert from "node:assert/strict";
import test from "node:test";
import { keepPinnedWindowVisibleAfterJump } from "../desktop/window-presence.js";

test("a pinned desktop pane is re-raised after terminal activation without being focused", () => {
  const calls = [];
  let settled;
  let unrefed = false;
  const window = {
    isDestroyed: () => false,
    showInactive: () => calls.push("showInactive"),
    moveTop: () => calls.push("moveTop"),
  };

  keepPinnedWindowVisibleAfterJump({
    window,
    shouldRestore: () => true,
    applyPin: () => calls.push("applyPin"),
    schedule: (callback, delay) => {
      settled = callback;
      assert.equal(delay, 120);
      return { unref: () => { unrefed = true; } };
    },
  });

  assert.deepEqual(calls, ["applyPin", "showInactive", "moveTop"]);
  assert.equal(unrefed, true);
  settled();
  assert.deepEqual(calls, [
    "applyPin",
    "showInactive",
    "moveTop",
    "applyPin",
    "showInactive",
    "moveTop",
  ]);
  assert.equal(calls.includes("focus"), false);
});

test("an explicit hide or destroyed window cancels desktop restoration", () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    showInactive: () => calls.push("showInactive"),
    moveTop: () => calls.push("moveTop"),
  };

  assert.equal(
    keepPinnedWindowVisibleAfterJump({
      window,
      shouldRestore: () => false,
      applyPin: () => calls.push("applyPin"),
      schedule: () => assert.fail("must not schedule a restore"),
    }),
    null,
  );
  assert.deepEqual(calls, []);
});
