import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  ENTER_TUI_SCREEN,
  LEAVE_TUI_SCREEN,
  renderTuiFrame,
} from "../src/tui-screen.js";

const CSI = "\u001b[";
const SWITCHBOARD = fileURLToPath(new URL("../src/bin/switchboard.js", import.meta.url));

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

test("a TUI startup failure releases the terminal screen exactly once", () => {
  const bootstrap = `
    process.argv = [process.execPath, ${JSON.stringify(SWITCHBOARD)}];
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    process.stdin.setRawMode = (enabled) => {
      if (enabled) throw new Error("forced startup failure");
    };
    await import(${JSON.stringify(pathToFileURL(SWITCHBOARD).href)});
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", bootstrap],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Switchboard: forced startup failure/);
  assert.equal(result.stdout, `${ENTER_TUI_SCREEN}${LEAVE_TUI_SCREEN}`);
});
