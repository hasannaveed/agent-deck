import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTER_TUI_SCREEN,
  LEAVE_TUI_SCREEN,
  renderTuiFrame,
} from "../src/tui-screen.js";

const CSI = "\u001b[";

test("a shrinking TUI frame erases every row from the previous frame", () => {
  const previous = renderTuiFrame(["session B", "session A", "footer"], 3);
  const current = renderTuiFrame(["session A"], 3);

  assert.match(previous, /session B/);
  assert.doesNotMatch(current, /session B/);
  assert.equal(
    current,
    `${CSI}H${CSI}2K\rsession A\r\n${CSI}2K\r\r\n${CSI}2K\r${CSI}J`,
  );
});

test("the TUI restores terminal autowrap when it releases the screen", () => {
  assert.match(ENTER_TUI_SCREEN, /\u001b\[\?1049h/);
  assert.match(ENTER_TUI_SCREEN, /\u001b\[\?7l/);
  assert.match(ENTER_TUI_SCREEN, /\u001b\[\?25l/);
  assert.match(LEAVE_TUI_SCREEN, /\u001b\[\?7h/);
  assert.match(LEAVE_TUI_SCREEN, /\u001b\[\?25h/);
  assert.match(LEAVE_TUI_SCREEN, /\u001b\[\?1049l/);
});
