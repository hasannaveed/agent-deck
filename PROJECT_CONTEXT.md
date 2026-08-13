# Agent Deck Project Context

This document is the durable handoff for future development sessions. Read it before changing the project, especially when a new coding-agent session has little or no conversation history.

The working product name is **Agent Deck**. Much of the current package, runtime, UI copy, configuration, and integration code still uses **Agent Switchboard**. A complete rename has not been performed and should be treated as a separate, coordinated change.

For deeper implementation detail, also read:

- `README.md` for installation, commands, and user-facing behavior.
- `docs/ARCHITECTURE.md` for the event model, state derivation, storage, and focus architecture.
- The implementation itself when documentation and code disagree. The reducer and tests are authoritative for state behavior.

## Product purpose

Agent Deck is a local, single-user session monitor for terminal-based coding agents. It currently tracks:

- OpenAI Codex
- Claude Code
- OpenCode

The product solves a specific problem: a developer may have several coding-agent sessions open across terminal windows, tabs, tmux panes, and workspaces, but should not have to cycle through every terminal to learn which agent is working, finished, waiting, or broken.

It provides two clients over the same local daemon:

- A native Electron desktop pane that can remain visible above other applications.
- A keyboard-first terminal UI.

Both clients must show the same sessions and the same derived states. Detection and state fixes belong in the daemon, adapters, reducer, or store—not as separate guesses in each UI.

This is an active-session dashboard, not a permanent archive or transcript browser. The default view should contain only live sessions. Closed sessions may appear briefly in the explicit Recent view, then expire.

## Core product rules

These rules encode decisions made during development and should not be casually weakened:

1. Show active sessions by default, not every historical session ever created.
2. Keep the daemon, TUI, and desktop pane independently startable. The TUI does not require the desktop pane.
3. Derive one canonical read model in the daemon and share it between both interfaces.
4. Show **Needs you** only for a real permission, question, authentication request, clarification, or other explicit human-input request.
5. A pending or running tool is ordinary work and must not become **Needs you**.
6. Show **Unread** only after a reliable completion/result event that the user has not seen. Silence alone is not completion.
7. Do not create separate visible rows for helper processes or nested agents that belong to one top-level session.
8. Do not read or store prompts, responses, terminal text, command contents, question text, answer options, permission paths, or tool payloads.
9. A jump must target a validated terminal coordinate. Never guess by title or inject shell text.
10. Report jump success only when the target was actually activated.
11. Reuse an existing terminal window, tab, tmux client, or pane whenever possible. Avoid opening duplicate terminal windows.
12. Jumping must never close the desktop pane. It remains above other windows and returns to its compact always-on-top position after the target is focused.
13. Do not seed demo sessions automatically. Demo data is opt-in through the explicit demo command.
14. Keep harness-specific behavior behind adapters or integrations so more harnesses can be added later without redesigning either UI.
15. Keep setup and uninstall conservative, current-user-only, idempotent, and respectful of existing configuration.

## High-level architecture

```text
Codex hooks          Claude hooks          OpenCode plugin
      \                    |                    /
       +------- normalized lifecycle events --+
                              |
Linux /proc discovery --------+
                              v
                    reducer + SQLite store
                              |
                    local HTTP API + SSE
                         /             \
                       TUI       Electron desktop

app/terminal coordinates --> validated focus providers --> existing window or pane
```

The dependency flow should stay in this direction:

- Harness integrations translate native lifecycle signals into normalized version-1 events.
- Linux process discovery supplies conservative presence and activity fallback signals.
- The reducer owns session state transitions and unread semantics.
- SQLite persists events, sessions, attention records, and client read state.
- The HTTP server exposes a local read/write API and an SSE stream.
- The TUI and Electron renderer consume the same daemon state.
- Focus providers activate structured application and terminal targets.

The default daemon address is `127.0.0.1:43117`. Runtime state is stored below `$XDG_STATE_HOME/agent-switchboard`, or `~/.local/state/agent-switchboard` when `XDG_STATE_HOME` is unset.

Node.js 22.5 or newer is required because the project uses the built-in `node:sqlite` module. The daemon and TUI are dependency-light; Electron supplies the native desktop shell.

## Canonical session state model

Session state is composed from independent dimensions rather than stored as one mutable label:

- **Presence:** live or closed
- **Activity:** working, interrupted, idle, or unknown
- **Attention:** required or none
- **Unread:** completion sequence newer than the client's seen sequence
- **Error:** current terminal/session error

The displayed primary state follows this precedence:

```text
error > needs_attention > working > interrupted > unread > idle > unknown/open > recent
```

That precedence is intentional. For example, a session can have an unread result and then begin working again; its primary state is **Working** until it stops.

| Display state | Meaning | What should produce it |
| --- | --- | --- |
| Error | The session has a current failure | Explicit harness error or validated runtime failure |
| Needs you | Progress is blocked on the human | Permission, question, login/authentication, clarification, or explicit input request |
| Working | The agent is actively doing work | Native busy/turn/tool activity or sufficiently strong process activity evidence |
| Interrupted | The human stopped the active turn | Explicit harness abort/cancel lifecycle signal; never a completion or unread result |
| Unread | Work completed and its result has not been seen | A reliable completion event increments the completion sequence |
| Idle | The live session is open but not working | Native idle signal or a quiet foreground process after the activity timeout |
| Open | The process is live but activity is not yet known | Presence without enough activity evidence |
| Recent | The session has ended | Closed session retained only in the Recent view for a limited time |

Important transition rules:

- Native, explicit harness events outrank process inference.
- An explicit attention request remains active until it is explicitly resolved. Generic busy traffic must not erase it.
- Human-initiated new work may resolve an old attention request when the harness semantics make that safe.
- Completion increments `completionSeq`; each client records its own `seenSeq`.
- Interruption clears Working without incrementing `completionSeq`; the next turn clears Interrupted.
- A successful jump marks the session seen. Merely selecting, inspecting, or unsuccessfully jumping does not.
- A quiet process becomes Idle after the configured idle interval; quietness must not synthesize Unread.
- A closed session leaves Active as soon as its end is known. Process-discovered exits are normally detected on the next discovery scan.

Current defaults:

- Process discovery interval: 2.5 seconds
- Activity-to-idle interval: 7.5 seconds
- Recent-session retention: 24 hours
- Maximum Recent rows: 20

## Identity, duplicate suppression, and retention

A canonical session key is derived from the harness and the harness-native session identifier. Process discovery can temporarily create a provisional identity, which must merge into the native identity once lifecycle events arrive.

Duplicate prevention is required at several levels:

- Normalized event IDs are deduplicated.
- Provisional process rows merge into native rows by process and terminal evidence.
- Superseded rows for the same harness, workspace, and terminal target are collapsed.
- Only top-level foreground harness processes should become visible sessions.
- Background, suspended, headless editor, and helper processes must not become rows.
- OpenCode tool shells carry `AGENT_SWITCHBOARD_CHILD=1`; nested OpenCode instances that inherit it are suppressed.

When the daemon read model or both clients contain duplicate sessions, fix identity or reconciliation centrally. Do not hide those duplicates independently in the TUI and desktop renderer. A non-selectable ghost that appears only in the TUI is instead governed by the screen lifecycle invariant in `docs/ARCHITECTURE.md`.

Closed rows should never remain in the Active list just because they still exist in SQLite. They belong only in Recent until retention or the row limit removes them. A stale target that fails a jump should also trigger or accelerate reconciliation rather than remaining indefinitely visible as live.

## Harness integrations

### Codex

Codex lifecycle hooks/app-server events are translated into session start, turn/work start, approval or input requests, completion, error, and end events. Approvals and `requestUserInput`-style events are attention requests. Running tools remain Working.

Codex users may need to trust the installed hooks once through Codex's `/hooks` flow. Existing Codex processes should be restarted after integration changes.

### Claude Code

Claude hooks translate lifecycle events such as user prompts, permission requests, elicitation, questions, stop/completion, failure, and session end. `AskUserQuestion`, `PermissionRequest`, and equivalent elicitation events are Needs you; tool execution is Working.

Existing Claude Code processes should be restarted after hook changes.

### OpenCode

OpenCode uses the generated plugin installed at:

```text
~/.config/opencode/plugins/switchboard.js
```

The source template in this project is `integrations/opencode/switchboard.js`. Update the source template, reinstall it, and restart OpenCode; do not directly maintain only the generated installed copy.

The plugin recognizes session lifecycle/status events, permission requests and updates, and question events, including current and version-2 event shapes.

Permission and question detection has extra reliability logic because event bursts previously caused prompt events to be lost:

- The plugin uses one persistent, ordered newline-delimited event stream instead of spawning one detached process per event.
- Critical prompt events are queued and replayable.
- Noisy status/update events may be coalesced.
- Delivery retries with bounded backoff without blocking OpenCode.
- Once per second, the plugin reconciles OpenCode's pending permission and question list APIs.
- If one of several pending prompts resolves, reconciliation resolves the missing request and then reasserts any remaining requests so the session stays Needs you.

This covers permission types such as external-directory access and OpenCode's preference/clarification questions. The plugin deliberately strips permission patterns, paths, question text, options, answers, model content, and tool content before emission.

After changing the OpenCode plugin, run:

```bash
npm run opencode:install
```

Then restart any already-running OpenCode sessions.

## Linux process discovery

Process discovery is fallback and reconciliation, not a substitute for native lifecycle events.

The discovery loop:

- Examines `/proc` for exact supported executable signatures.
- Requires a relevant foreground process group and controlling terminal, except
  for the explicitly identified Codex app server owned by the VS Code extension.
- Rejects child/helper, background, suspended, and headless service processes.
- Samples CPU and I/O counters to infer activity without reading terminal content.
- Uses safe non-content hints, such as Codex tmux pane state and OpenCode lifecycle/tool-state metadata, where available.
- Emits process-seen, process-gone, work, and idle evidence into the same reducer path as native events.
- Records VS Code as an application host separately from terminal metadata. The
  extension-host PID is used to map one app server to its existing editor window;
  native Codex thread IDs and workspaces remain authoritative.
- For a hook-confirmed Codex approval in tmux only, two consecutive working-title scans resolve the approval; `Action Required`, a non-working scan, a new approval, or any non-approval attention resets or disables this evidence.

Counter activity may mean Working. Counter quietness may mean Idle. It must never mean Needs you, Interrupted, or Unread. Codex interruption is detected from the explicit `turn_aborted` lifecycle record in a bounded rollout tail; content-bearing records are ignored and never persisted.

## TUI behavior

The TUI can run without the desktop pane, but it expects the daemon to be reachable.

It shows a visually separated row per session with a dedicated harness column so Codex, Claude Code, and OpenCode are never ambiguous. State labels use distinct glyphs and colors.

Current views:

- `1` Active
- `2` Needs
- `3` Unread
- `4` Work
- `5` Open
- `6` Recent

Current controls:

- Up/Down arrows or `j`/`k`: move selection
- Enter: jump to the selected session
- `i`: inspect details
- `m`: toggle read/unread where applicable
- `d`: dismiss a closed recent session
- `r`: refresh
- Escape: leave the detail view
- `q`: quit

The TUI polls approximately every 1.2 seconds. `switchboard --once` prints active sessions once; `switchboard --once --all` also includes Recent.

When the TUI is running in a normal terminal and the target is an existing tmux pane, it may attach the current terminal to that tmux server/session if there is no already-attached exact route. The TUI temporarily suspends while attached. Detaching with the tmux detach binding returns to the TUI.

## Desktop pane behavior

The supported GUI is a native Electron desktop pane, not a normal website. Its renderer assets live in `web/`, but Electron owns the application window and native focus integration.

Expected behavior:

- Default position: bottom-right of the usable desktop area.
- Always on top in both expanded and collapsed modes; this is not a user-toggleable preference.
- Visible across workspaces where the window manager supports it.
- Minimize, hide, and close actions collapse it to a small bottom-right dock instead of quitting.
- Clicking the dock expands the full pane.
- A tray action and `Ctrl+Shift+Space` can restore/toggle it.
- Up/Down arrows move the selected row.
- Enter jumps to the selected session.
- Jumping leaves the GUI process and pane alive.
- Repeated clicks or key presses during one focus attempt are deduplicated so they do not open multiple windows.

On Linux, Electron defaults to XWayland for this app because native Wayland does not reliably permit always-on-top and restacking behavior. `SWITCHBOARD_NATIVE_WAYLAND=1` opts into native Wayland, with the known tradeoff that the desktop environment may ignore z-order requests.

After a jump, the terminal should receive keyboard focus while the pane remains visibly above it. The GNOME bridge performs a follow-up restack of the switchboard without stealing terminal keyboard focus.

The desktop launcher filters Chromium's exact `GetVSyncParametersIfAvailable()` fallback and `_NET_RESTACK_WINDOW` atom-cache diagnostics while preserving every other stderr line. Treat other Chromium/XWayland messages as actionable when they accompany visible blanking, flicker, broken focus, or a crash.

## Terminal jumping and focus providers

Every focusable session stores a structured application or terminal target. Focus providers validate all coordinates and arguments before performing an action. No focus path may construct an arbitrary shell command from event data.

### VS Code

The official Codex extension is recognized by its `openai.chatgpt-*` executable,
code-mode app-server arguments, and VS Code extension-host ancestry. The daemon
stores `hostApplication: vscode` and the extension-host PID independently from
`terminalKind`. At jump time, the GNOME bridge raises a sole validated VS Code
window immediately. If several editor windows exist, `code --status` maps the
extension host to its exact renderer PID before activation. A detected live host
never falls back to opening its workspace behind the foreground app; connector
or mapping failures remain visible to the user. Legacy records without a host
PID may still reopen their recorded workspace without shell interpolation.
Exact selection of an individual Codex thread is not available through the
upstream extension's public interface.

### tmux

- If the current TUI is already connected to the same tmux server, select the exact target session/window/pane in that client.
- Otherwise, prefer the most recently active attached client that can show the target and focus its existing graphical terminal window.
- From a non-tmux TUI terminal, attaching that terminal to the target is allowed when it is the best exact route.
- From the desktop, open one graphical terminal only when the target tmux session is detached and no existing attached client can be focused.

The desired behavior is to switch an existing tmux client, not spawn several terminal windows or leave a background terminal filled with tmux redraw characters.

### GNOME Terminal

GNOME Terminal exposes a D-Bus screen identity to child processes but does not provide a sufficient public activation API for arbitrary existing tabs. The project therefore installs a small GNOME Shell extension that maps the recorded screen identity to the real Mutter window/tab and activates it.

The bridge supports the GNOME versions documented in `README.md`. It auto-links newly discovered agent terminals and repeats linking at safe lifecycle boundaries such as session start or a user prompt. It must not relink on every background event.

If automatic linking is stale, use the detail action **Repair terminal jump** or run this inside the target terminal tab:

```bash
switchboardctl link
```

A GNOME Shell logout/login may be needed after first installing or updating the extension.

### Other providers

- WezTerm uses its CLI with an exact pane identifier.
- kitty requires a configured remote-control socket.
- Zellij targets a known session and may attach through a graphical terminal when needed.
- Unsupported, stale, or malformed targets fail safely and must not claim success.

Wayland intentionally prevents arbitrary applications from reliably raising unrelated windows. The GNOME extension is the desktop-specific solution for supported GNOME Terminal cases; there is no portable title-based fallback.

## Local API and security model

The service binds to loopback by default. Mutating API requests require a generated 256-bit bearer token. The server also applies host restrictions and a content security policy.

The event payload schema is deliberately metadata-only. Safe fields include identifiers, harness, timestamps, workspace, project/branch metadata, process identity, validated application-host or terminal coordinates, and coarse lifecycle state. Unsafe fields include prompts, responses, terminal output, commands, tool arguments/results, questions, answers, permission paths/patterns, and model content.

Focus targets are treated as untrusted input even though the service is local. Providers must validate identifiers and invoke subprocesses with argument arrays, never shell interpolation.

## Installation and daily commands

Initial local setup:

```bash
npm ci
npm run setup
```

Useful setup variants:

```bash
npm run setup -- --dry-run
npm run setup -- --autostart
```

Normal startup:

```bash
npm run daemon
npm run tui
```

The desktop pane can be started separately with:

```bash
npm run gui
```

`npm start` is also an Electron desktop entry point. If the desktop starts while no daemon is reachable, it can own an embedded runtime; if a healthy daemon is already running, it reuses it. Starting a second standalone daemon on the same address produces the expected “already running”/address-in-use error.

Health and integration checks:

```bash
npm run doctor
npm run check
```

Integration-specific installers:

```bash
npm run opencode:install
npm run gnome:install
```

Conservative removal:

```bash
npm run uninstall -- --dry-run
npm run uninstall
```

Setup is intentionally current-user-only and should not require `sudo`. It merges supported hook configuration rather than replacing unrelated entries, creates recovery backups under the switchboard state directory, refuses unsafe symlink/foreign-destination situations, and can be run repeatedly. The generated hook commands contain absolute paths to this checkout, so rerun setup after moving the project directory.

The optional systemd user unit under `integrations/systemd/` is a template. Standard setup does not silently install a system service or edit shell startup files.

Useful direct commands exposed by the package are:

```text
switchboardd
switchboard
switchboardctl doctor
switchboardctl list
switchboardctl integrations
switchboardctl link
switchboardctl seen
switchboardctl unread
switchboardctl dismiss
switchboardctl demo
```

`switchboardctl demo` is deliberately explicit and must never run during normal startup.

## Source map

| Area | Main files |
| --- | --- |
| Event and state vocabulary | `src/domain.js` |
| Harness normalization | `src/adapters/` |
| State transitions | `src/reducer.js` |
| SQLite persistence/read model | `src/store.js` |
| Runtime orchestration | `src/runtime.js` |
| Local API and SSE | `src/server.js`, `src/client.js` |
| Linux process discovery | `src/discovery/linux.js` |
| Focus routing | `src/focus.js` |
| Automatic terminal linking | `src/terminal-auto-link.js` |
| tmux client selection | `src/tmux-clients.js` |
| GNOME integration | `src/gnome-bridge.js`, `integrations/gnome-shell/` |
| Daemon/TUI/control entry points | `src/bin/switchboardd.js`, `src/bin/switchboard.js`, `src/bin/switchboardctl.js` |
| Electron lifecycle/window behavior | `desktop/main.js`, `desktop/windowing.js`, `desktop/preload.js` |
| Desktop renderer | `web/` |
| Codex and Claude hooks | `integrations/` and `src/adapters/` |
| OpenCode source plugin | `integrations/opencode/switchboard.js` |
| Setup/uninstall/validation | `scripts/setup.js`, `scripts/uninstall.js`, `scripts/check.js` |
| Automated coverage | `test/` |

## Adding another harness

A future harness should fit the existing architecture rather than add UI-specific detection:

1. Add the harness identifier to the domain vocabulary.
2. Implement a native adapter or plugin that emits normalized events.
3. Emit stable native session IDs and safe terminal coordinates.
4. Add process discovery only as a conservative fallback.
5. Define exactly which native events mean work, explicit attention, resolution, completion, error, and end.
6. Add duplicate/child-process suppression appropriate to that harness.
7. Add integration installation and doctor checks without overwriting user configuration.
8. Add reducer, adapter, discovery, focus, setup, and end-to-end tests as relevant.
9. Let both interfaces receive the new harness through the existing daemon read model.

Do not infer attention from a tool name, CPU quietness, or terminal text. If the harness lacks a reliable signal, display the lower-confidence state rather than fabricating certainty.

## Validation and definition of done

The standard verification command is:

```bash
npm run check
```

It performs syntax/configuration checks and runs the Node test suite. The suite covers adapters, reducer semantics, persistence, process discovery, duplicate suppression, terminal focus, GNOME bridging, OpenCode installation and prompt delivery, desktop window behavior, setup, and uninstall safety.

For behavior changes, a future session should also verify the actual end-to-end path:

- Harness event is emitted.
- Daemon receives and persists it.
- Reducer derives the correct primary state.
- Both TUI and desktop show the same state.
- Jump activates exactly one intended target.
- Desktop remains alive and above other windows after the jump.
- No sensitive content appears in stored events or diagnostics.

Use temporary state directories in tests and diagnostics. Do not contaminate the user's live session database or integrations with demo/test data.

## Known constraints and troubleshooting anchors

- **Daemon already running:** usually another daemon or the Electron-owned runtime already holds `127.0.0.1:43117`. Reuse it or stop the correct owner; do not start duplicate daemons.
- **TUI shows too many rows:** distinguish a selectable daemon-backed session from a non-selectable screen ghost; follow the identity guidance above or the TUI screen lifecycle invariant in `docs/ARCHITECTURE.md`.
- **Working never changes:** confirm native events first, then process sampling and idle timeout. Do not solve it by treating every live process as Working forever.
- **Needs you is missing:** inspect the harness's explicit permission/question events and delivery/reconciliation path. Do not parse terminal text.
- **Needs you appears during tools:** inspect event classification; pending/running tools must remain Working.
- **Unread is wrong:** completion sequence and per-client seen sequence are the source of truth. Do not derive Unread from inactivity.
- **Closed row remains Active:** inspect process-gone/session-ended delivery and the active query, not only UI filtering.
- **One jump opens several windows:** inspect focus-operation deduplication and existing-client selection before adding launch fallbacks.
- **GNOME jump changes a pane but Chrome stays focused:** activation and window raising are separate steps; verify the GNOME bridge activates the terminal window and then restacks the desktop pane without taking keyboard focus.
- **Desktop disappears on jump:** inspect Electron window lifecycle and renderer event handling. Jump must not call quit, close, or destructive hide behavior.
- **OpenCode misses permissions/questions:** verify the installed plugin is current, restart OpenCode, inspect the persistent stream, and verify pending-list reconciliation.

## New-session starting checklist

When continuing this project in a fresh coding-agent session:

1. Read this file completely.
2. Read `README.md` and `docs/ARCHITECTURE.md`.
3. Inspect the relevant implementation and tests before proposing a change; do not rely only on remembered conversation.
4. Run `npm run doctor` when diagnosing a live integration problem.
5. Run `npm run check` before and after implementation.
6. Preserve the product rules above unless the user explicitly changes them.
7. Prefer a central detection/state/focus fix over duplicated TUI and GUI workarounds.
8. Update this document when a substantial architectural decision, supported harness, state rule, focus strategy, setup behavior, or known constraint changes.

The concise mental model is: **metadata-only harness events plus conservative process fallback feed one deterministic daemon; two clean clients show active work and jump to validated existing application or terminal targets.**
