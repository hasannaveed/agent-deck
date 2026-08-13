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

test("non-tmux TUI attaches to tmux in its current terminal without opening a window", async () => {
  const runs = [];
  const attachments = [];
  let launched = false;
  const result = await focusSession(liveSession(), {
    env: {},
    reuseCurrentTmux: true,
    attachCurrentTmux: async (file, args) => attachments.push([file, args]),
    which: (name) => (name === "tmux" ? "/usr/bin/tmux" : null),
    run: async (file, args) => {
      runs.push([file, args]);
      return args.includes("display-message")
        ? { stdout: "agents\n", stderr: "" }
        : { stdout: "", stderr: "" };
    },
    launch: async () => {
      launched = true;
    },
  });

  assert.deepEqual(result, {
    ok: true,
    provider: "tmux",
    reused: true,
    attached: true,
    message: "Returned from tmux pane %7.",
  });
  assert.deepEqual(attachments, [
    [
      "/usr/bin/tmux",
      ["-S", "/tmp/tmux-1000/default", "attach-session", "-t", "agents"],
    ],
  ]);
  assert.equal(runs.length, 2);
  assert.equal(launched, false);
});

test("non-tmux TUI focuses an existing attached GNOME tmux client first", async () => {
  const runs = [];
  let attached = false;
  let launched = false;
  const result = await focusSession(liveSession(), {
    env: {},
    reuseCurrentTmux: true,
    focusAttachedTmux: true,
    attachCurrentTmux: async () => {
      attached = true;
    },
    resolveTmuxClientTerminal: (pid) =>
      pid === 321
        ? {
            terminalKind: "gnome-terminal",
            terminalTarget: "/org/gnome/Terminal/screen/abc_123",
            terminalInstance: ":1.42",
          }
        : null,
    which: (name) =>
      ({ tmux: "/usr/bin/tmux", gdbus: "/usr/bin/gdbus" })[name] || null,
    run: async (file, args) => {
      runs.push([file, args]);
      if (args.includes("display-message")) return { stdout: "agents\t1\n", stderr: "" };
      if (args.includes("list-clients")) return { stdout: "321\t1700000100\t/dev/pts/8\n", stderr: "" };
      if (file === "/usr/bin/gdbus") return { stdout: "(true, 'Focused terminal.')\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    launch: async () => {
      launched = true;
    },
  });

  assert.deepEqual(result, {
    ok: true,
    provider: "tmux",
    reused: true,
    focused: true,
    clientPid: 321,
    message: "Focused the existing tmux terminal at pane %7.",
  });
  assert.equal(runs.some(([, args]) => args.includes("list-clients")), true);
  assert.equal(runs.some(([file]) => file === "/usr/bin/gdbus"), true);
  assert.equal(attached, false);
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

test("desktop tmux focus repairs a missed GNOME link before activating the terminal", async () => {
  const bridgeMethods = [];
  let focusAttempts = 0;
  const result = await focusSession(liveSession(), {
    reuseAttachedTmux: true,
    focusAttachedTmux: true,
    resolveTmuxClientTerminal: () => ({
      terminalKind: "gnome-terminal",
      terminalTarget: "/org/gnome/Terminal/screen/abc_123",
      terminalInstance: ":1.42",
    }),
    which: (name) => ({ tmux: "/usr/bin/tmux", gdbus: "/usr/bin/gdbus" })[name] || null,
    run: async (file, args) => {
      if (args.includes("display-message")) return { stdout: "agents\t1\n", stderr: "" };
      if (args.includes("list-clients")) return { stdout: "321\t1700000100\t/dev/pts/8\n", stderr: "" };
      if (file !== "/usr/bin/gdbus") return { stdout: "", stderr: "" };

      const method = args.find((value) => value.startsWith("com.skylabs.AgentSwitchboard.GnomeBridge1."));
      bridgeMethods.push(method);
      if (method.endsWith("CaptureTerminal")) {
        assert.equal(args.at(-1), "true");
        return { stdout: "(true, 'Recovered terminal link.')\n", stderr: "" };
      }
      focusAttempts += 1;
      return focusAttempts === 1
        ? { stdout: "(false, 'Automatic linking was missed.')\n", stderr: "" }
        : { stdout: "(true, 'Focused terminal.')\n", stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.focused, true);
  assert.deepEqual(bridgeMethods, [
    "com.skylabs.AgentSwitchboard.GnomeBridge1.FocusTerminal",
    "com.skylabs.AgentSwitchboard.GnomeBridge1.CaptureTerminal",
    "com.skylabs.AgentSwitchboard.GnomeBridge1.FocusTerminal",
  ]);
});

test("desktop tmux focus does not report success when its terminal cannot be activated", async () => {
  const result = await focusSession(liveSession(), {
    reuseAttachedTmux: true,
    focusAttachedTmux: true,
    resolveTmuxClientTerminal: () => ({
      terminalKind: "gnome-terminal",
      terminalTarget: "/org/gnome/Terminal/screen/abc_123",
      terminalInstance: ":1.42",
    }),
    which: (name) => ({ tmux: "/usr/bin/tmux", gdbus: "/usr/bin/gdbus" })[name] || null,
    run: async (file, args) => {
      if (args.includes("display-message")) return { stdout: "agents\t1\n", stderr: "" };
      if (args.includes("list-clients")) return { stdout: "321\t1700000100\t/dev/pts/8\n", stderr: "" };
      if (file === "/usr/bin/gdbus") return { stdout: "(false, 'Automatic linking was missed.')\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "gnome_terminal_unlinked");
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
  assert.equal(
    result.message,
    "Automatic terminal linking was missed. Focus the target tab, then use Repair terminal jump or run switchboardctl link there.",
  );
});

test("VS Code focus asks the GNOME connector to raise a sole editor window immediately", async () => {
  const calls = [];
  let launched = false;
  const result = await focusSession(
    liveSession({
      terminalKind: null,
      terminalTarget: null,
      terminalInstance: null,
      hostApplication: "vscode",
      hostPid: 7846,
      cwd: "/work/aim-project",
      project: "aim-project",
    }),
    {
      which: (name) => ({ code: "/usr/bin/code", gdbus: "/usr/bin/gdbus" })[name] || null,
      run: async (file, args) => {
        calls.push([file, args]);
        return { stdout: "(true, 'Focused the existing VS Code window.')\n", stderr: "" };
      },
      launch: async () => {
        launched = true;
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    provider: "vscode",
    reused: true,
    message: "Focused the existing VS Code window.",
  });
  assert.equal(launched, false);
  assert.deepEqual(calls, [[
    "/usr/bin/gdbus",
    [
      "call",
      "--session",
      "--dest",
      "com.skylabs.AgentSwitchboard.GnomeBridge",
      "--object-path",
      "/com/skylabs/AgentSwitchboard/GnomeBridge",
      "--method",
      "com.skylabs.AgentSwitchboard.GnomeBridge1.FocusApplicationWindow",
      "7846",
      "vscode",
    ],
  ]]);
});

test("VS Code focus maps the exact renderer when several editor windows exist", async () => {
  const calls = [];
  let bridgeCalls = 0;
  const result = await focusSession(
    liveSession({
      terminalKind: null,
      terminalTarget: null,
      terminalInstance: null,
      hostApplication: "vscode",
      hostPid: 7846,
      cwd: "/work/aim-project",
      project: "aim-project",
    }),
    {
      which: (name) => ({ code: "/usr/bin/code", gdbus: "/usr/bin/gdbus" })[name] || null,
      run: async (file, args, options) => {
        calls.push([file, args, options]);
        if (file === "/usr/bin/code") {
          assert.equal(options.timeoutMs, 8000);
          return {
            stdout: [
              "CPU % Mem MB PID Process",
              "0 400 7549 window [1] (aim-project - Visual Studio Code)",
              "0 200 7846 extension-host [1]",
            ].join("\n"),
            stderr: "",
          };
        }
        bridgeCalls += 1;
        return bridgeCalls === 1
          ? { stdout: "(false, 'Several VS Code windows are running.')\n", stderr: "" }
          : { stdout: "(true, 'Focused the existing VS Code window.')\n", stderr: "" };
      },
      launch: async () => assert.fail("a live hosted session must not open another workspace"),
    },
  );

  assert.deepEqual(result, {
    ok: true,
    provider: "vscode",
    reused: true,
    message: "Focused the existing VS Code window.",
  });
  assert.equal(calls[0][1].at(-2), "7846");
  assert.deepEqual(calls[1].slice(0, 2), ["/usr/bin/code", ["--status"]]);
  assert.equal(calls[2][1].at(-2), "7549");
});

test("VS Code focus reports an older live connector instead of opening in the background", async () => {
  let launched = false;
  const result = await focusSession(
    liveSession({
      terminalKind: null,
      terminalTarget: null,
      terminalInstance: null,
      hostApplication: "vscode",
      hostPid: 7846,
      cwd: "/work/aim-project",
    }),
    {
      which: (name) => ({ code: "/usr/bin/code", gdbus: "/usr/bin/gdbus" })[name] || null,
      run: async () => {
        const error = new Error("No such method FocusApplicationWindow");
        error.stderr = "GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such method FocusApplicationWindow";
        throw error;
      },
      launch: async () => {
        launched = true;
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "gnome_bridge_upgrade_required");
  assert.match(result.message, /log out and back in once/i);
  assert.equal(launched, false);
});

test("a legacy VS Code route without a host PID can reopen the known workspace", async () => {
  const launches = [];
  const result = await focusSession(
    liveSession({
      terminalKind: null,
      terminalTarget: null,
      terminalInstance: null,
      hostApplication: "vscode",
      cwd: "/work/aim-project",
      project: "aim-project",
    }),
    {
      which: (name) => (name === "code" ? "/usr/bin/code" : null),
      run: async () => assert.fail("status lookup is unnecessary without the GNOME connector"),
      launch: async (file, args) => launches.push([file, args]),
    },
  );

  assert.deepEqual(result, {
    ok: true,
    provider: "vscode",
    launched: true,
    message: "Opened aim-project in VS Code.",
  });
  assert.deepEqual(launches, [["/usr/bin/code", ["/work/aim-project"]]]);
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
        liveSession({
          terminalKind: null,
          terminalTarget: null,
          hostApplication: "vscode",
          hostPid: "$(touch nope)",
          cwd: "$(touch nope)",
        }),
        options,
      )
    ).code,
    "vscode_window_unavailable",
  );
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
