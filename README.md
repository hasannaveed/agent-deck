# Agent Switchboard

One local pane for active and recent Codex, Claude Code, and OpenCode sessions.
Switchboard surfaces the sessions that matter now—working, waiting for you,
finished but unread, idle, or errored—without turning your entire agent history
into an inbox.

It includes:

- a native Electron desktop pane with always-on-top, tray, and hide/show controls;
- click-to-jump routing for tmux, WezTerm, kitty, Zellij, and GNOME Terminal sessions;
- an interactive terminal UI with a prominent harness column;
- a local SQLite event store and Server-Sent Events stream;
- native adapters for Codex, Claude Code, and OpenCode;
- a dependency-free daemon and TUI (the desktop shell uses Electron);
- Linux process discovery with low-confidence working/idle inference when hooks
  are not yet installed.

## Quick start

Switchboard requires Node.js 22.5 or newer because it uses Node's built-in
SQLite module. Install dependencies and open the desktop pane:

```bash
npm install
npm start
```

The window stays above normal windows by default, can hide to the system tray,
and remembers its size, position, and pin state. `Ctrl+Shift+Space` toggles it.
On Linux, pinned mode remains keyboard-focusable while staying above other
applications and across workspaces. Use `↑`/`↓` (or `j`/`k`) to select a visible
session and `Enter` to jump to it. The desktop process starts the local daemon
when one is not already running.

Open the TUI against that same daemon in another terminal:

```bash
npm run tui
```

To preview every state, run `node src/bin/switchboardctl.js demo`. The demo is
optional; live Linux process discovery starts automatically.

Install an application-menu launcher (and optionally start the pane at login):

```bash
npm run desktop:install
npm run desktop:install -- --autostart
```

On GNOME 42–44, install the companion extension for exact switching to ordinary
GNOME Terminal windows and tabs:

```bash
npm run gnome:install
```

Install exact permission/question detection for OpenCode:

```bash
npm run opencode:install
```

Restart OpenCode sessions that were already running when the plugin was
installed. Future OpenCode permission and question prompts then appear as
`NEEDS YOU`; ordinary pending or running tools remain `WORKING`.

The generated launcher points to this checkout, so keep the project at the same
path. For a headless daemon plus TUI, use `npm run daemon` and `npm run tui`.

For convenient commands during development, run `npm link` once and then use
`switchboardd`, `switchboard`, and `switchboardctl` directly.

## Connect real harnesses

Process discovery estimates state from non-content terminal status metadata and
OpenCode lifecycle fields when available, then falls back to process activity
counters. It never reads pane, message, tool, or transcript content. Hooks
provide exact activity plus attention, unread, and error states. Run:

```bash
switchboardctl integrations
```

Queued or pending tools count as working. `NEEDS YOU` is reserved for an explicit
human-input signal such as a permission request, question, authentication step,
or Codex's `Action Required` status.

OpenCode instances launched from an agent tool shell are treated as nested work
and folded into their top-level parent instead of becoming additional rows. The
integration forwards this ownership marker through detached tmux sessions
without inspecting shell commands.

A reliable harness transition from `WORKING` to finished becomes `UNREAD` until
you successfully jump to that session or mark it seen. Counter-only process
sampling remains conservative: a process that merely goes quiet becomes `IDLE`,
so long silent tools do not create false unread results.

Then merge the relevant template from [`integrations/`](./integrations/README.md)
into each harness configuration. The hook bridge sends lifecycle metadata only;
it does not persist prompts, responses, tool inputs, command text, or transcripts.
Hook delivery has a 450 ms deadline and fails silently, so an offline daemon does
not interfere with the harness.

## Commands

```text
npm start                           open the native desktop pane
npm run daemon                      run only the local daemon
npm run tui                         open the interactive terminal UI
npm run gnome:install               install the GNOME Terminal focus connector
npm run opencode:install             install exact OpenCode prompt events
switchboardd [--no-discovery]       run the local daemon
switchboard                         open the TUI (daemon must be running)
switchboard --once                  print active sessions with harness labels
switchboard --once --all            include recently closed sessions
switchboardctl doctor               inspect runtime, daemon, and harness setup
switchboardctl list [--json]        print active and recent sessions
switchboardctl demo                 load all representative states
switchboardctl demo --clear         remove only demo-generated sessions
switchboardctl link                 repair a missed GNOME Terminal route
switchboardctl seen <id>            acknowledge completed work
switchboardctl unread <id>          put a session back in the unread queue
switchboardctl dismiss <id>         hide a closed session
switchboardctl integrations         locate native integration templates
```

In the desktop pane, click a row or press `Enter` to jump to it; press `I` or use
the row's colored state label to inspect signals without acknowledging the session.
Successful jumps leave the Switchboard pane visible and mark unread work as seen.
The pane opens at the bottom right. Minimize, hide, and the window close control
collapse it into a compact status dock there; click the dock to restore the full
pane. The collapsed dock stays in front even when the regular pin is turned off,
while the pin button controls whether the expanded pane also stays always-on-top.
On Linux the small desktop pane uses XWayland by default because Electron's native
Wayland backend does not support programmatic z-order changes. Set
`SWITCHBOARD_NATIVE_WAYLAND=1` only if you prefer native Wayland over guaranteed
always-on-top behavior.

TUI keys are `↑`/`↓` or `j`/`k` to move, `Enter` to jump to the selected terminal
pane, `i` to inspect without acknowledging, `m` to toggle read state, `d` to
dismiss a closed session, `1`–`6` to filter, `r` to refresh, and `q` to quit.
Every row identifies `CODEX`, `CLAUDE CODE`, or `OPENCODE` in a dedicated column.
The TUI starts on the `Active` view; recently closed sessions remain available
under `Recent` instead of crowding the live-session list. Process-only discovery
rows briefly show `OPEN` while the activity sampler establishes a baseline, then
move between inferred `WORKING` and `IDLE`. Native integration signals replace
those estimates with exact `WORKING`, `IDLE`, `NEEDS YOU`, `UNREAD`, or `ERROR`
states.

## Session jumping

Switchboard records a structured terminal target alongside each live session:

- tmux: selects the exact pane, focuses an existing attached client's terminal,
  and attaches through the current TUI terminal only as a fallback;
- WezTerm: activates the exact pane through `wezterm cli` and preserves its GUI
  socket when available;
- kitty: focuses the exact window when kitty was started with remote control and
  a `KITTY_LISTEN_ON` Unix socket;
- Zellij: opens a graphical terminal attached to the matching Zellij session.
- GNOME Terminal: uses its inherited screen ID plus a small GNOME Shell
  extension to activate its Wayland window and select its tab.

GNOME Terminal deliberately does not expose a public “activate this existing
screen” method. After installing the connector, Switchboard automatically
records a newly launched agent's focused window and tab. Native `SessionStart`
and user-prompt hooks provide additional safe capture points without inspecting
prompt content. Background completion and tool events are deliberately excluded
so they cannot associate the wrong tab.

Ordinarily no linking action is required. If an agent was already running before
the connector or daemon started, or if its tab was moved or reordered, try to
open it once. Switchboard then reveals **Repair terminal jump** in the session
details. Focus the target terminal tab and choose that action, or run
`switchboardctl link` inside the tab. The route is stored by GNOME screen ID and
normally lasts for that tab's lifetime.

The TUI uses these same validated targets when you press `Enter`. If the TUI and
agent are on the same tmux server, it switches the existing client directly to
that pane. Otherwise, Switchboard inspects the target session's attached tmux
clients, selects the most recently active one, and focuses its existing GNOME
Terminal window and tab through the Shell connector. This creates no terminal,
tmux client, session, or agent process.

If an attached tmux client's GNOME route was missed, the desktop pane asks the
connector to recover it from its remembered terminal and retries activation. If
activation still fails, the jump reports that failure instead of claiming
success after changing only the hidden tmux pane.

If no attached terminal can be safely focused, the TUI temporarily leaves the
Switchboard screen and attaches that same terminal to the target tmux session.
Detach with tmux's normal `Ctrl-b d` binding to return to the TUI. The desktop
pane opens one graphical terminal only when the session is detached.

Other plain terminal processes do not expose a portable focus identifier. When
a safe jump route is unavailable, clicking opens the signal detail and explains
why. This is especially important on Wayland, where applications cannot
generally force an unrelated window to the foreground.

## What appears in the queue

The display priority is deliberately stable:

1. error;
2. needs attention;
3. unread completion;
4. working;
5. open/idle;
6. recently closed.

The default Active queue contains live processes only. Once discovery confirms
that a process exited, it leaves Active on the next scan (2.5 seconds by default),
even if its last result was unread or errored. Closed sessions remain available
only in the explicit Recent view for 24 hours, with at most 20 recent rows, and
cannot be jumped to. Override those defaults with `SWITCHBOARD_RECENT_HOURS`,
`SWITCHBOARD_MAX_RECENT`, and `SWITCHBOARD_DISCOVERY_INTERVAL_MS`.

Linux process discovery is intentionally limited to foreground harnesses with a
controlling terminal. Suspended jobs and headless editor services are excluded,
and persisted process rows are reconciled whenever the daemon starts. Superseded
process rows for the same harness, workspace, and terminal are collapsed from
the read model so daemon or harness restarts do not create duplicate entries.

State is stored under `$XDG_STATE_HOME/agent-switchboard`, or
`~/.local/state/agent-switchboard` when `XDG_STATE_HOME` is unset. Useful runtime
variables are:

```text
SWITCHBOARD_HOME
SWITCHBOARD_HOST             default 127.0.0.1
SWITCHBOARD_PORT             default 43117
SWITCHBOARD_RECENT_HOURS     default 24
SWITCHBOARD_MAX_RECENT       default 20
SWITCHBOARD_DISCOVERY_INTERVAL_MS
SWITCHBOARD_ACTIVITY_IDLE_MS      default 7500
```

The HTTP service binds to loopback by default. Mutating endpoints require a
random bearer token stored with owner-only permissions in the state directory.
Requests with a foreign `Host` header are rejected to guard the renderer token
endpoint against DNS rebinding.

## Verify the build

```bash
npm test
npm run check
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the adapter boundary,
state semantics, and the path for adding another harness.
