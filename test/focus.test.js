import assert from "node:assert/strict";
import test from "node:test";
import { focusSession } from "../src/focus.js";

function liveSession(overrides = {}) {
  return {
    presence: "live",
    terminalKind: "tmux",
    terminalTarget: "%7",
    terminalInstance: "/tmp/tmux-1000/default",
    ...overrides,
  };
}

test("tmux focus selects the exact pane and opens an attached graphical terminal", async () => {
  const runs = [];
  const launches = [];
  const which = (name) => ({ tmux: "/usr/bin/tmux", "gnome-terminal": "/usr/bin/gnome-terminal" })[name] || null;
  const run = async (file, args) => {
    runs.push([file, args]);
    return args.includes("display-message") ? { stdout: "agents\n", stderr: "" } : { stdout: "", stderr: "" };
  };
  const launch = async (file, args) => launches.push([file, args]);

  const result = await focusSession(liveSession(), { which, run, launch });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "tmux");
  assert.deepEqual(runs[0][1], [
    "-S",
    "/tmp/tmux-1000/default",
    "display-message",
    "-p",
    "-t",
    "%7",
    "#{session_name}",
  ]);
  assert.deepEqual(runs[1][1].slice(-7), ["select-window", "-t", "%7", ";", "select-pane", "-t", "%7"]);
  assert.deepEqual(launches[0], [
    "/usr/bin/gnome-terminal",
    ["--", "/usr/bin/tmux", "-S", "/tmp/tmux-1000/default", "attach-session", "-t", "agents"],
  ]);
});

test("TUI tmux focus reuses the current client on the same server", async () => {
  const runs = [];
  let launched = false;
  const result = await focusSession(liveSession(), {
    env: { TMUX: "/tmp/tmux-1000/default,1234,0" },
    reuseCurrentTmux: true,
    which: (name) => (name === "tmux" ? "/usr/bin/tmux" : null),
    run: async (file, args) => {
      runs.push([file, args]);
      return args.includes("display-message") ? { stdout: "agents\n", stderr: "" } : { stdout: "", stderr: "" };
    },
    launch: async () => {
      launched = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, "Switched to tmux pane %7.");
  assert.equal(result.reused, true);
  assert.equal(runs.length, 2);
  assert.equal(launched, false);
});

test("desktop tmux focus reuses an attached terminal instead of opening another window", async () => {
  const runs = [];
  let launched = false;
  const result = await focusSession(liveSession(), {
    reuseAttachedTmux: true,
    which: (name) => (name === "tmux" ? "/usr/bin/tmux" : null),
    run: async (file, args) => {
      runs.push([file, args]);
      return args.includes("display-message") ? { stdout: "agents\t2\n", stderr: "" } : { stdout: "", stderr: "" };
    },
    launch: async () => {
      launched = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.launched, undefined);
  assert.equal(result.message, "Switched the attached terminal to tmux pane %7.");
  assert.equal(runs.length, 2);
  assert.equal(runs[0][1].at(-1), "#{session_name}\t#{session_attached}");
  assert.equal(launched, false);
});

test("WezTerm and kitty focus commands use validated numeric targets", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    return { stdout: "", stderr: "" };
  };
  const which = (name) => ({ wezterm: "/usr/bin/wezterm", kitten: "/usr/bin/kitten" })[name] || null;

  assert.equal(
    (
      await focusSession(
        liveSession({
          terminalKind: "wezterm",
          terminalTarget: "42",
          terminalInstance: "/run/user/1000/wezterm/gui-sock-1",
        }),
        { which, run },
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await focusSession(
        liveSession({ terminalKind: "kitty", terminalTarget: "91", terminalInstance: "unix:/tmp/kitty-control" }),
        { which, run },
      )
    ).ok,
    true,
  );
  assert.deepEqual(calls, [
    ["/usr/bin/wezterm", ["cli", "activate-pane", "--pane-id", "42"]],
    ["/usr/bin/kitten", ["@", "--to", "unix:/tmp/kitty-control", "focus-window", "--match", "id:91"]],
  ]);
});

test("GNOME Terminal focus uses the shell bridge without opening another window", async () => {
  const calls = [];
  const result = await focusSession(
    liveSession({
      terminalKind: "gnome-terminal",
      terminalTarget: "/org/gnome/Terminal/screen/abc_123",
      terminalInstance: ":1.142",
    }),
    {
      which: (name) => (name === "gdbus" ? "/usr/bin/gdbus" : null),
      run: async (file, args) => {
        calls.push([file, args]);
        return { stdout: "(true, 'Focused the linked GNOME Terminal tab.')\n", stderr: "" };
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    provider: "gnome-terminal",
    reused: true,
    message: "Focused the linked GNOME Terminal tab.",
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
        "com.skylabs.AgentSwitchboard.GnomeBridge1.FocusTerminal",
        ":1.142",
        "/org/gnome/Terminal/screen/abc_123",
      ],
    ],
  ]);
});

test("GNOME Terminal reports an unlinked tab instead of launching a replacement", async () => {
  const result = await focusSession(
    liveSession({
      terminalKind: "gnome-terminal",
      terminalTarget: "/org/gnome/Terminal/screen/abc_123",
      terminalInstance: ":1.142",
    }),
    {
      which: () => "/usr/bin/gdbus",
      run: async () => ({
        stdout: "(false, 'This tab is not linked yet.')\n",
        stderr: "",
      }),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "gnome_terminal_unlinked");
  assert.equal(result.message, "This tab is not linked yet.");
});

test("unsupported, stale, and malformed targets fail without executing commands", async () => {
  let executed = false;
  const options = {
    which: () => "/usr/bin/tool",
    run: async () => {
      executed = true;
    },
  };
  assert.equal((await focusSession(liveSession({ presence: "closed" }), options)).code, "not_live");
  assert.equal((await focusSession(liveSession({ terminalTarget: "$(touch nope)" }), options)).code, "tmux_unavailable");
  assert.equal(
    (await focusSession(liveSession({ terminalKind: "kitty", terminalTarget: "91", terminalInstance: "tcp:bad:1" }), options))
      .code,
    "kitty_unavailable",
  );
  assert.equal((await focusSession(liveSession({ terminalKind: null, terminalTarget: null }), options)).code, "unsupported_terminal");
  assert.equal(
    (
      await focusSession(
        liveSession({ terminalKind: "gnome-terminal", terminalTarget: "$(touch nope)", terminalInstance: ":1.2" }),
        options,
      )
    ).code,
    "gnome_terminal_unavailable",
  );
  assert.equal(executed, false);
});
