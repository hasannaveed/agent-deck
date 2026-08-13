import assert from "node:assert/strict";
import test from "node:test";
import {
  captureGnomeTerminal,
  focusGnomeApplicationWindow,
  parseGnomeBridgeReply,
  raiseGnomeSwitchboard,
  validGnomeApplication,
  validGnomeTerminalScreen,
  validGnomeTerminalService,
  validGnomeWindowPid,
} from "../src/gnome-bridge.js";

const terminal = {
  terminalKind: "gnome-terminal",
  terminalTarget: "/org/gnome/Terminal/screen/abc_123",
  terminalInstance: ":1.142",
};

test("GNOME bridge targets and replies are strictly validated", () => {
  assert.equal(validGnomeTerminalService(":1.142"), ":1.142");
  assert.equal(validGnomeTerminalService("org.gnome.Terminal"), null);
  assert.equal(validGnomeTerminalScreen(terminal.terminalTarget), terminal.terminalTarget);
  assert.equal(validGnomeTerminalScreen("/org/gnome/Terminal/screen/../../bad"), null);
  assert.equal(validGnomeApplication("vscode"), "vscode");
  assert.equal(validGnomeApplication("$(touch nope)"), null);
  assert.equal(validGnomeWindowPid(7549), 7549);
  assert.equal(validGnomeWindowPid("not-a-pid"), null);
  assert.deepEqual(parseGnomeBridgeReply("(true, 'Linked this tab.')\n"), {
    ok: true,
    message: "Linked this tab.",
  });
  assert.deepEqual(parseGnomeBridgeReply("(false, 'Link it again.')\n"), {
    ok: false,
    message: "Link it again.",
  });
  assert.equal(parseGnomeBridgeReply("not a tuple"), null);
});

test("the GNOME bridge focuses only a validated application window", async () => {
  const calls = [];
  const result = await focusGnomeApplicationWindow(
    { application: "vscode", pid: 7549 },
    {
      which: (name) => (name === "gdbus" ? "/usr/bin/gdbus" : null),
      run: async (file, args) => {
        calls.push([file, args]);
        return { stdout: "(true, 'Focused the existing VS Code window.')\n", stderr: "" };
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    message: "Focused the existing VS Code window.",
  });
  assert.deepEqual(calls[0][1].slice(-3), [
    "com.skylabs.AgentSwitchboard.GnomeBridge1.FocusApplicationWindow",
    "7549",
    "vscode",
  ]);
});

test("explicit GNOME linking may use the last focused terminal without shell interpolation", async () => {
  const calls = [];
  const result = await captureGnomeTerminal(terminal, {
    allowLast: true,
    which: (name) => (name === "gdbus" ? "/usr/bin/gdbus" : null),
    run: async (file, args) => {
      calls.push([file, args]);
      return { stdout: "(true, 'Linked this session.')\n", stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, "Linked this session.");
  assert.deepEqual(calls[0][1].slice(-4), [
    "com.skylabs.AgentSwitchboard.GnomeBridge1.CaptureTerminal",
    ":1.142",
    "/org/gnome/Terminal/screen/abc_123",
    "true",
  ]);
});

test("the GNOME bridge raises Switchboard without activating or focusing it", async () => {
  const calls = [];
  const result = await raiseGnomeSwitchboard({
    which: (name) => (name === "gdbus" ? "/usr/bin/gdbus" : null),
    run: async (file, args) => {
      calls.push([file, args]);
      return { stdout: "(true, 'Kept Agent Switchboard above other windows.')\n", stderr: "" };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    message: "Kept Agent Switchboard above other windows.",
  });
  assert.deepEqual(calls, [
    [
      "/usr/bin/gdbus",
      [
        "call",
        "--session",
        "--dest",
        "com.skylabs.AgentSwitchboard.GnomeBridge",
        "--object-path",
        "/com/skylabs/AgentSwitchboard/GnomeBridge",
        "--method",
        "com.skylabs.AgentSwitchboard.GnomeBridge1.RaiseSwitchboard",
      ],
    ],
  ]);
});
