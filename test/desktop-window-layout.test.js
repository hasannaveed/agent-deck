import assert from "node:assert/strict";
import test from "node:test";
import {
  collapsedBoundsAtBottomRight,
  expandedBoundsAtBottomRight,
  looksLikeMaximizedBounds,
} from "../desktop/window-layout.js";

const workArea = { x: 0, y: 28, width: 1920, height: 1052 };

test("desktop layouts share a bottom-right anchor", () => {
  assert.deepEqual(expandedBoundsAtBottomRight(workArea), {
    x: 1474,
    y: 244,
    width: 430,
    height: 820,
  });
  assert.deepEqual(collapsedBoundsAtBottomRight(workArea), {
    x: 1736,
    y: 1012,
    width: 168,
    height: 52,
  });
});

test("the expanded layout preserves its prior size while returning to the anchor", () => {
  assert.deepEqual(
    expandedBoundsAtBottomRight(workArea, { x: 1200, y: 40, width: 510, height: 620 }),
    { x: 1394, y: 444, width: 510, height: 620 },
  );
});

test("maximized bounds are not remembered as the expanded pane size", () => {
  const maximized = { x: 0, y: 28, width: 1920, height: 1052 };
  assert.equal(looksLikeMaximizedBounds(workArea, maximized), true);
  assert.equal(
    looksLikeMaximizedBounds(workArea, { x: 100, y: 28, width: 1800, height: 620 }),
    false,
  );
  assert.deepEqual(expandedBoundsAtBottomRight(workArea, maximized), {
    x: 1474,
    y: 244,
    width: 430,
    height: 820,
  });
});
