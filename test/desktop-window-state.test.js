import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDesktopState,
  rememberableExpandedBounds,
} from "../desktop/window-state.js";

test("desktop state always restores the pane as pinned", () => {
  assert.deepEqual(
    normalizeDesktopState({
      layoutVersion: 3,
      pinned: false,
      collapsed: true,
      expandedBounds: { x: 10, y: 20, width: 430, height: 700 },
    }),
    {
      layoutVersion: 3,
      pinned: true,
      collapsed: true,
      expandedBounds: { x: 10, y: 20, width: 430, height: 700 },
    },
  );
});

test("only normal expanded window bounds are persisted", () => {
  const maximized = {
    isDestroyed: () => false,
    isNormal: () => false,
    getBounds: () => assert.fail("maximized bounds must not be read"),
  };
  assert.equal(
    rememberableExpandedBounds(maximized, { minWidth: 360, minHeight: 500 }),
    null,
  );

  const normalBounds = { x: 100, y: 80, width: 430, height: 720 };
  const normal = {
    isDestroyed: () => false,
    isNormal: () => true,
    getBounds: () => normalBounds,
  };
  assert.deepEqual(
    rememberableExpandedBounds(normal, { minWidth: 360, minHeight: 500 }),
    normalBounds,
  );
});
