# Agent Deck / Agent Switchboard — Detailed Project Description

## Document purpose

This document is a portfolio-oriented technical description of the project. It explains the product problem, user experience, system architecture, feature implementation, security model, testing strategy, current scope, and engineering decisions in enough detail to support:

- resume and portfolio preparation;
- technical blog posts and case studies;
- LinkedIn project descriptions;
- interview discussions;
- onboarding future contributors; and
- evaluating the project against other work in a project bank.

For installation commands and day-to-day usage, see the repository `README.md`. For shorter, reusable descriptions, see `docs/PROJECT_SUMMARY.md`.

## Project identity and status

| Item | Current value |
| --- | --- |
| Working product name | Agent Deck |
| Name used by the implementation | Agent Switchboard |
| Package name | `agent-switchboard` |
| Version | `0.1.0` |
| License | MIT |
| Primary platform | Linux |
| Supported coding harnesses | OpenAI Codex, Claude Code, and OpenCode |
| Main clients | Native Electron desktop pane and terminal UI |
| Runtime | Node.js 22.5 or newer |
| Persistence | SQLite through Node's built-in `node:sqlite` module |
| Desktop dependency | Electron |
| Default local address | `127.0.0.1:43117` |
| Current automated test suite | 113 passing Node test cases |

The repository is in the middle of a naming transition: product planning uses **Agent Deck**, while package names, UI copy, paths, and most source code still use **Agent Switchboard**. A complete rename is intentionally treated as a separate change so runtime paths, integrations, desktop entries, and user configuration are not broken accidentally.

## Executive overview

Agent Switchboard is a local, privacy-conscious operations dashboard for developers running several AI coding-agent sessions at the same time. It discovers active Codex, Claude Code, and OpenCode sessions across terminals, multiplexers, workspaces, and VS Code; converts harness-specific activity into one canonical state model; and presents the result in both a native desktop pane and a keyboard-first terminal interface.

The project answers three practical questions:

1. Which agent sessions are currently working, idle, interrupted, complete, waiting for input, or in error?
2. Which completed results have not been reviewed yet?
3. How can the developer return to the exact existing terminal pane, terminal tab, multiplexer session, or editor window without manually searching through the desktop?

The system is deliberately an **active-session control surface**, not a transcript reader or permanent message archive. It stores lifecycle and routing metadata but does not ingest prompts, model responses, terminal text, commands, tool payloads, permission paths, or question contents.

## The problem it solves

AI-assisted development often produces a fragmented working environment. A developer may have:

- one Codex session in a tmux pane;
- a Claude Code task waiting for approval in another terminal tab;
- an OpenCode session running a long tool call;
- a Codex session hosted by a VS Code extension;
- several terminal windows spread across workspaces; and
- completed results that are easy to miss once focus moves elsewhere.

The individual tools report state differently, use different event names, and expose different navigation capabilities. Without a shared control surface, the developer must repeatedly inspect terminals to discover what changed. That interrupts concentration and does not scale well as the number of concurrent agents increases.

Agent Switchboard centralizes this operational state while keeping each coding tool independent. It does not launch or own the agents, and an agent continues working if Switchboard is stopped.

## Product goals

The implementation is guided by the following goals:

- Show the sessions that matter now instead of exposing an unbounded history.
- Use one shared state model for the desktop pane and terminal UI.
- Distinguish ordinary agent work from genuine human-attention requests.
- Treat unread completion as an explicit, reliable event rather than inferring it from silence.
- Make returning to a session fast and safe when an exact focus coordinate is available.
- Avoid duplicate rows for provisional identities, helper processes, nested agents, or restarted processes.
- Keep all data and control traffic on the user's machine.
- Avoid collecting conversation or terminal content.
- Preserve existing harness configuration during setup and uninstall.
- Remain useful without the Electron client: the daemon and TUI can operate independently.
- Make additional coding harnesses addable through adapters instead of UI-specific logic.

## Explicit non-goals

The current project is not intended to be:

- a transcript browser or prompt-history database;
- a remote team dashboard;
- a multi-user or multi-tenant service;
- a replacement terminal or terminal multiplexer;
- a coding-agent launcher or process supervisor;
- a cross-device synchronization service;
- a general process monitor; or
- a system that guesses window targets from titles and injects shell input.

These boundaries are important to the product's privacy, reliability, and manageable scope.

## Feature set

### Unified live-session queue

Both clients display Codex, Claude Code, and OpenCode sessions with a consistent harness label, title, project context, age, and derived state. The default view contains live sessions. Recently closed sessions move to an explicit Recent view and expire according to retention settings.

Available views include:

- Active;
- Needs your input;
- Unread results;
- Working;
- Open/idle/interrupted; and
- Recent.

The desktop interface additionally supports text search across title, project, working directory, branch, and harness.

### Canonical operational states

The visible state vocabulary is:

- **Error** — the harness reported a current failure.
- **Needs you** — a permission, question, authentication step, elicitation, clarification, or other explicit human input is required.
- **Working** — the agent is actively processing a turn or tool.
- **Interrupted** — the human stopped the active turn.
- **Unread** — a reliable completion occurred and has not been acknowledged.
- **Idle** — the session is live but not currently working.
- **Open** — the process is live but there is not yet enough evidence to classify activity.
- **Recent** — the session has ended and is temporarily retained.

The system distinguishes a queued or running tool from a human-attention request. Pending tool execution remains **Working**; only an explicit request for human action becomes **Needs you**.

### Unread-result tracking

The reducer stores a `completionSeq` and `seenSeq` for every session. A reliable successful or failed completion increments the completion sequence. The session is unread when the completion sequence is newer than the seen sequence.

A result is acknowledged when the user:

- successfully jumps to the session; or
- explicitly marks it seen.

Selecting or inspecting a row does not acknowledge it. An unsuccessful jump also leaves it unread. The user can manually mark a result unread again.

### Exact session jumping

When a validated target exists, selecting a session can activate the existing environment:

| Environment | Focus strategy |
| --- | --- |
| VS Code | Map the Codex extension-host process to the existing editor window through the GNOME connector; use `code --status` to disambiguate multiple windows; reopen a recorded workspace only for legacy records without a live host PID. |
| tmux | Validate the pane ID, select the exact pane, reuse the current or an attached client when possible, focus that client's terminal, or attach/open a terminal only as a fallback. |
| WezTerm | Call `wezterm cli activate-pane` with a validated numeric pane ID and the recorded GUI socket when present. |
| kitty | Use kitty remote control with a validated window ID and `KITTY_LISTEN_ON` Unix address. |
| Zellij | Launch a supported graphical terminal attached to the validated Zellij session. |
| GNOME Terminal | Use a small GNOME Shell D-Bus bridge to activate the recorded window and tab associated with a stable terminal screen identifier. |

Unsupported or stale targets remain visible, but the UI reports them as non-focusable instead of pretending a jump succeeded.

### Native desktop pane

The Electron client is a compact, frameless operations pane rather than a conventional browser page. It provides:

- an always-on-top bottom-right layout;
- a compact collapsed status dock;
- system-tray controls;
- a global `Ctrl+Shift+Space` toggle;
- persistence of the last normal expanded size;
- protection against accidental maximize and fullscreen modes;
- visibility across workspaces where supported;
- keyboard navigation and Enter-to-jump;
- search and state filters;
- live counts and a visual traffic rail;
- session details and recent activity metadata;
- read/unread and recent-session dismissal actions;
- GNOME Terminal route repair; and
- deduplication of repeated jump requests.

Closing, hiding, or minimizing normally collapses the app into its small status dock instead of quitting it. On Linux, the app defaults to Electron's XWayland path because native Wayland does not reliably permit the required always-on-top restacking behavior. Native Wayland can be requested with `SWITCHBOARD_NATIVE_WAYLAND=1` when that tradeoff is acceptable.

### Terminal UI

The TUI provides the same daemon-backed session data without requiring Electron. It includes:

- responsive full-screen rendering;
- dedicated harness and state columns;
- color and glyph distinctions for every state;
- six keyboard-selectable views;
- session details and recent lifecycle events;
- read/unread and dismissal actions;
- one-shot output for scripts and non-interactive terminals; and
- in-place tmux attachment when no exact graphical route is available.

The TUI polls approximately every 1.2 seconds. Its screen lifecycle is exception-safe: it uses the alternate screen, disables autowrap while rendering, erases every physical row on every frame, and restores raw mode, cursor visibility, autowrap, and the original screen on quit, startup failure, or tmux handoff.

### Linux process discovery

Native hooks provide the most accurate state, but the product remains useful before integrations are installed. The Linux discovery loop scans `/proc` every 2.5 seconds by default and:

- matches exact supported executable signatures;
- admits foreground, interactive harness processes;
- recognizes Codex app-server processes owned by the official VS Code extension;
- rejects suspended, background, headless, helper, and nested harness processes;
- records working directory, PID, process start time, host application, and structured terminal coordinates;
- uses CPU and I/O counter changes as low-confidence activity evidence;
- reads non-content terminal status hints where available;
- emits process-seen, process-gone, working, idle, and narrowly defined attention events into the same reducer as native events; and
- reconciles persisted sessions against current processes during daemon startup.

Quiet process counters can produce **Idle**, but they never synthesize **Unread**, **Interrupted**, or **Needs you**. This avoids treating long-running silent work as a finished result.

### Privacy-preserving native integrations

The setup flow installs or merges lifecycle integrations for each harness:

- Codex hooks;
- Claude Code hooks; and
- an OpenCode event plugin.

Only safe lifecycle metadata crosses the integration boundary. The OpenCode plugin explicitly strips permission patterns, file paths associated with permissions, question text, answer options, answers, model content, tool content, and command text. Codex rollout inspection parses only short lifecycle records from bounded file regions. The database never becomes a copy of agent conversations.

### Conservative setup and uninstall

The root `install.sh` file provides the normal one-command installation after a
repository clone. It verifies that Node and npm are available, installs the
exact dependencies from `package-lock.json`, and delegates to the existing safe
setup pipeline. The same flow is available as `npm run install:user`.

The unified installer is current-user-only and does not require `sudo`. It can:

- preview changes with `--dry-run`;
- merge missing Codex and Claude hook groups;
- install the generated OpenCode plugin;
- install an application-menu launcher;
- optionally add desktop autostart;
- install and enable the GNOME connector on supported desktops;
- run environment diagnostics; and
- launch the desktop pane.

Before changing an existing JSON configuration, it validates the structure and saves a one-time backup. It refuses malformed JSON, symbolic-link configs, non-regular files, and foreign files occupying managed destinations. Writes are atomic, and a manifest records the exact hook entries owned by Switchboard.

Uninstall removes only exact entries and files recorded as Switchboard-owned. If a managed hook was later edited, it is preserved for manual review. Runtime state is preserved unless the explicit `--purge` option is used after the daemon and desktop app are stopped.

## System architecture

### Architectural style

The system is an event-driven local application with four major layers:

1. **Signal ingestion** — harness hooks, the OpenCode plugin, and Linux discovery produce lifecycle evidence.
2. **Normalization and reduction** — adapters translate native shapes into a common versioned event schema, and a pure reducer updates canonical session state.
3. **Persistence and transport** — SQLite stores events and session projections; a loopback HTTP server exposes JSON endpoints and Server-Sent Events.
4. **Presentation and navigation** — the Electron renderer and TUI consume the same read model, while trusted native code performs validated focus actions.

```text
Codex hooks ───────────────┐
Claude Code hooks ────────┼──> harness adapter ──> normalized event ──┐
OpenCode event plugin ────┤                                           │
Linux /proc discovery ────┘                                           v
                                                               state reducer
                                                                     │
                                                                     v
                                                             SQLite event store
                                                                     │
                                                ┌────────────────────┴────────────────────┐
                                                v                                         v
                                         HTTP JSON + SSE                         session focus layer
                                          /           \                     /       |       |       \
                                         v             v                   tmux   terminals  GNOME   VS Code
                                  Electron pane       TUI
```

### Runtime components

| Component | Responsibility | Key implementation files |
| --- | --- | --- |
| Runtime bootstrap | Create private state, initialize SQLite, start the API, and start/stop discovery | `src/runtime.js`, `src/config.js` |
| Domain contract | Validate, sanitize, version, and identify normalized events | `src/domain.js` |
| Harness adapters | Convert Codex, Claude Code, and OpenCode event shapes into the common contract | `src/adapters/` |
| State reducer | Apply deterministic transitions and derive presentation state | `src/reducer.js` |
| Persistent store | Deduplicate events, merge identities, persist projections, query snapshots, and emit change notifications | `src/store.js` |
| Linux discovery | Detect supported processes and infer conservative activity | `src/discovery/linux.js` |
| Local API | Serve GUI assets, JSON resources, actions, and an SSE stream | `src/server.js` |
| Focus providers | Validate structured targets and activate existing sessions | `src/focus.js`, `src/gnome-bridge.js`, `src/tmux-clients.js`, `src/vscode.js` |
| Desktop shell | Manage the Electron process, daemon ownership, trusted IPC, native window behavior, and tray | `desktop/` |
| Desktop renderer | Render queues and details, search/filter, consume SSE, and request trusted desktop operations | `web/` |
| Terminal client | Render the full-screen TUI and perform keyboard-driven actions | `src/bin/switchboard.js` |
| Control CLI | Diagnose, ingest hook events, manage demo data, repair links, and update read state | `src/bin/switchboardctl.js` |
| Installers | Safely merge integrations and install desktop/GNOME/OpenCode components | `scripts/` |

### End-to-end event flow

An ordinary event follows this path:

1. A harness emits a native lifecycle notification, or discovery observes a process transition.
2. The harness-specific adapter translates the input into one or more schema-version-1 events.
3. Input values are sanitized, timestamps are bounded, confidence is clamped, and a stable hashed session key is generated.
4. The store opens an immediate SQLite transaction.
5. The event is inserted using a harness-scoped deduplication key.
6. A provisional process identity is merged into a native identity when PID and process-start evidence match.
7. The reducer updates the session projection.
8. The event and session changes commit atomically.
9. The store emits a change notification.
10. The HTTP service broadcasts an SSE update.
11. The desktop renderer refreshes its snapshot; the TUI sees the same state on its next poll.

This separation keeps harness-specific event formats out of both user interfaces.

## Normalized event model

Every adapter produces the same conceptual event shape:

```json
{
  "schemaVersion": 1,
  "eventId": "durable-native-id-or-generated-uuid",
  "harness": "codex",
  "nativeSessionId": "native-thread-or-session-id",
  "kind": "attention_requested",
  "nativeType": "PermissionRequest",
  "occurredAt": 1700000000000,
  "telemetry": "hook",
  "confidence": 1,
  "humanInitiated": false,
  "metadata": {
    "title": "Session monitor",
    "cwd": "/workspace/session-monitor",
    "project": "session-monitor",
    "branch": "main",
    "pid": 1234,
    "terminal": "tmux %3",
    "terminalKind": "tmux",
    "terminalTarget": "%3",
    "terminalInstance": "/tmp/tmux-1000/default",
    "hostApplication": null,
    "hostPid": null
  },
  "attention": {
    "kind": "approval",
    "requestId": "request-1",
    "summary": "Approval requested"
  }
}
```

Supported normalized event kinds are:

- `session_started`;
- `process_seen`;
- `process_gone`;
- `work_started`;
- `work_interrupted`;
- `activity_idle`;
- `attention_requested`;
- `attention_resolved`;
- `work_completed`;
- `session_error`; and
- `session_ended`.

The normalizer removes control characters, caps text and path lengths, rejects unknown harnesses and event kinds, prevents timestamps more than five minutes in the future, and assigns lower default confidence to process-derived evidence.

## State-reduction model

### Factored state

A session does not store one mutable status label. The reducer tracks independent facts:

- `presence`: live or closed;
- `activity`: working, interrupted, idle, or unknown;
- `attention`: required or none;
- completion and seen sequence numbers;
- current error kind and summary;
- telemetry source and confidence;
- process, terminal, and application routing metadata; and
- lifecycle timestamps.

The UI derives a primary state in this order:

```text
closed -> recent
otherwise: error > needs_attention > working > interrupted > unread > idle > unknown
```

Working outranks unread in the primary-state calculation because current activity is more immediately useful than an older unreviewed completion. When the final queue is sorted, unread-only sessions are placed ahead of working sessions.

### Important transition rules

- A native event takes precedence over generic process inference.
- Repeated native busy traffic does not clear an explicit permission or question.
- A human-initiated new turn can clear old attention and acknowledge earlier completion.
- An interruption clears working and attention but does not increment the completion sequence.
- Cleanup events immediately following an interruption do not turn it into a successful unread result.
- A successful completion becomes unread until acknowledged.
- A failure becomes both unread and error, with Error displayed as the primary state.
- A process exit immediately moves the row out of Active and into Recent.
- A new event reopens a dismissed session.
- Merely quiet process counters produce Idle, never Unread.

The reducer is intentionally deterministic and independent of the clients, making its behavior straightforward to test.

## Harness-specific implementation

### Codex adapter

The Codex adapter supports both hook-style and app-server-style events. It maps:

- session/thread start to session start;
- user prompt or turn start to working;
- permission requests, user-input tools, and MCP elicitation to attention;
- post-tool or resolved server requests to attention resolution;
- explicit abort/cancel states to interrupted;
- successful stop/completion to unread completion;
- failed turns and error notifications to error; and
- session/thread close to session end.

Durable turn identifiers are reused where possible so the same lifecycle transition arriving through two paths is deduplicated.

For CLI Codex sessions, discovery can inspect only a bounded prefix and tail of open rollout JSONL files. It rejects subagent rollouts and parses only `task_started`, `task_complete`, and human-interrupted `turn_aborted` records. Prompt, reasoning, tool, and assistant-content records are ignored.

For Codex in tmux, a hook-confirmed approval can be resolved when the pane title returns from `Action Required` to a working indicator for two consecutive scans. The debounce is tied to the exact attention event and never clears questions or other non-approval requests.

### Claude Code adapter

The Claude adapter maps session, prompt, permission, tool, notification, stop, failure, elicitation, and session-end hooks. It distinguishes:

- permission prompts;
- direct user questions;
- idle prompts that genuinely require the human;
- authentication success;
- elicitation dialogs and results;
- successful completion;
- interruption-like failures; and
- ordinary errors.

If Claude reports that background tasks are still active at Stop time, the session remains Working instead of being incorrectly marked complete.

### OpenCode plugin and adapter

OpenCode uses an installed event plugin rather than per-event command hooks. The plugin:

- filters to supported lifecycle, status, error, permission, and question events;
- converts inputs to a content-free lifecycle subset;
- forwards events through one persistent newline-delimited bridge process;
- coalesces noisy session-update and status messages;
- retains critical permission/question events for replay;
- retries delivery with bounded backoff;
- caps the queue while preferentially retaining critical events;
- polls pending permission and question APIs once per second;
- supports legacy and version-2 API shapes;
- resolves disappeared prompts and then reasserts any prompts still pending; and
- suppresses idle cleanup after a `MessageAbortedError` so interruption is not converted to completion.

The plugin marks tool-launched shells with `AGENT_SWITCHBOARD_CHILD=1`. It also asks tmux to forward that marker into detached sessions. Discovery uses this ownership signal and process ancestry to suppress nested OpenCode instances that belong to a parent agent's work.

## Process discovery and inference

### Process eligibility

A normal terminal-hosted process must:

- match an exact supported harness executable signature;
- own the foreground process group of a controlling terminal;
- be in a runnable state; and
- not have a supported harness ancestor or nested-work marker.

Codex app-server processes launched by the official VS Code extension are the controlled exception to the controlling-terminal rule. They are identified by extension path, `app-server`, the code-mode feature flag, and extension-host ancestry.

### Activity evidence

Discovery gathers only non-content evidence:

- process CPU ticks;
- aggregate read/write character counters;
- process state and foreground group;
- working directory and process start time;
- structured environment coordinates for supported terminals;
- Codex tmux status title;
- OpenCode assistant completion and tool pending/running lifecycle fields from its local SQLite database; and
- bounded Codex lifecycle records.

Animated terminal UIs can consume resources while idle, so the thresholds deliberately require meaningful activity: approximately 8% of one CPU core or 32 KiB/s of character I/O during the sample interval. If a process remains quiet for the configured interval, it becomes Idle.

### Evidence precedence

Process evidence is marked with lower confidence and generally stops updating activity after native telemetry has been established. Native completion, interruption, error, and human-attention signals remain authoritative. The narrow Codex tmux approval-resolution rule is an explicit reconciliation exception.

## Identity, deduplication, and reconciliation

The system prevents duplicate rows at several layers:

- Session URLs use a 24-hex-character SHA-256-derived key from harness and native session ID.
- Event IDs are deduplicated per harness by a unique SQLite key.
- Process-discovered sessions use provisional IDs based on PID and process start ticks.
- When a native event arrives with matching PID and start-time evidence, provisional event history is reassigned to the native session in the same transaction.
- A two-second process-start tolerance prevents minor timestamp differences from blocking a legitimate merge.
- PID reuse is guarded by process incarnation/start-time comparisons.
- Superseded process rows that share a harness, workspace, and terminal target are collapsed from the read model.
- Nested and helper harnesses are excluded before they become sessions.
- Daemon startup reconciles persisted live PID sessions with the current `/proc` snapshot.

These rules solve a common monitoring problem: process discovery can see a session before a native integration knows its durable session ID, but the user should still see only one row.

## Persistence layer

The store uses Node's built-in synchronous SQLite API with:

- foreign-key enforcement;
- a three-second busy timeout;
- write-ahead logging;
- explicit immediate transactions for event ingestion;
- prepared statements for hot operations; and
- lightweight schema migration for added routing columns.

### Main tables

| Table | Purpose |
| --- | --- |
| `sessions` | Current materialized session projection, including state dimensions, metadata, routing coordinates, timestamps, completion/seen sequences, and dismissal state. |
| `events` | Deduplicated lifecycle history containing session ID, harness, normalized kind, native event type, safe summary, and timestamps. |
| `adapter_health` | Latest readiness/error information for harness and discovery inputs. |
| `meta` | Schema version and installation metadata. |

The read model applies retention and duplicate collapsing after loading relevant projections. Closed sessions are kept for 24 hours by default, capped at 20 rows, and can be dismissed manually.

Runtime state is stored under `$XDG_STATE_HOME/agent-switchboard`, or `~/.local/state/agent-switchboard` when `XDG_STATE_HOME` is not configured.

## Local HTTP API and live updates

The dependency-free Node HTTP service serves both application assets and versioned JSON endpoints.

### Read endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /` | Serve the renderer application. |
| `GET /api/v1/health` | Return version, uptime, and adapter health. |
| `GET /api/v1/client-token` | Provide the local renderer/client write token. |
| `GET /api/v1/sessions` | Return counts and the sorted session snapshot. |
| `GET /api/v1/sessions/:id` | Return one trusted session and its recent event history. |
| `GET /api/v1/stream` | Open an SSE stream for change notifications and heartbeats. |

### Mutating endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/events` | Ingest one event or a batch of up to 64 events. |
| `POST /api/v1/sessions/:id/seen` | Acknowledge the latest completion. |
| `POST /api/v1/sessions/:id/unread` | Restore unread status. |
| `POST /api/v1/sessions/:id/dismiss` | Hide a recent session. |
| `POST /api/v1/demo/clear` | Remove only demo-generated records. |

Request bodies are capped at 256 KiB. Changes are announced over SSE, and the renderer debounces snapshot refreshes. The desktop also performs a 30-second reconciliation poll in case a stream update is missed.

## Security and privacy model

The project is designed as a single-user local service. Its defenses include:

- loopback binding by default;
- strict Host-header validation, including loopback-only rules, to reduce DNS-rebinding risk;
- a random 256-bit bearer token stored with owner-only permissions;
- constant-time token comparison;
- authentication on every mutating HTTP request;
- a private state directory and ownership marker;
- rejection of unsafe broad state paths and symbolic-link runtime files;
- Content Security Policy, no framing, no referrer, same-origin resource policy, and MIME-sniffing protection;
- Electron context isolation, sandboxing, disabled Node integration, denied permissions, and denied new windows;
- navigation restricted to the trusted local origin;
- a narrow frozen preload API;
- strict hashed-session-ID validation at the IPC boundary;
- server-side retrieval of the trusted session record before a native focus action;
- target validation for pane IDs, window IDs, Unix paths, D-Bus names, and screen paths; and
- child-process execution with argument arrays instead of shell interpolation.

The service is not hardened or designed for public network exposure. Changing the bind host should be treated as an advanced deployment decision, not a normal use case.

## Desktop trust boundary

The renderer never sends an arbitrary command or focus target to the Electron main process. It sends only a hashed session ID. The main process:

1. verifies the IPC sender's origin;
2. validates the ID format;
3. fetches the authoritative session detail from the daemon;
4. passes the stored structured coordinates to the focus layer; and
5. marks unread work seen only after a successful activation.

This prevents compromised or malformed renderer state from becoming an arbitrary command-execution interface.

## GNOME Shell connector

GNOME Terminal exposes stable D-Bus screen information but no public API that raises an existing tab. The bundled GNOME Shell 42–44 extension fills that compositor-level gap.

It exports a small session-bus interface with methods to:

- report protocol version;
- capture the currently focused terminal window/tab for a screen;
- focus a previously captured terminal screen;
- focus a validated VS Code application window; and
- restack Switchboard above other windows without taking keyboard focus.

Routes contain only the terminal service, screen object path, GNOME window path, tab index, and capture timestamp. They are stored in a private state file. Automatic capture is limited to safe foreground moments such as a newly discovered process, session start, or human-submitted prompt. Background completion events are not allowed to rewrite a route.

## Command-line surface

### Main executables

- `switchboardd` — run the daemon, API, SQLite store, and optional Linux discovery.
- `switchboard` — run the interactive TUI or print a one-shot session list.
- `switchboardctl` — diagnostics, event ingestion, state actions, demo management, and route repair.

### Installation commands

- `./install.sh` performs the recommended complete installation, enables desktop autostart, runs diagnostics, and launches the app.
- `npm run install:user` is the equivalent npm entry point.
- `./install.sh --dry-run` previews managed destinations without installing dependencies or changing user files.
- `./install.sh --no-autostart`, `--no-launch`, `--skip-gnome`, `--skip-hooks`, and `--skip-dependencies` provide explicit advanced control.
- `npm run setup` remains available for component-level development and repair after dependencies have already been installed.

### Important control commands

- `switchboardctl doctor` checks Node, platform, harness executables, hook/plugin installation, daemon status, and state paths.
- `switchboardctl list [--json]` prints the canonical snapshot.
- `switchboardctl emit` translates native hook JSON and delivers it with a short deadline.
- `switchboardctl event` creates a manual normalized event for development.
- `switchboardctl demo` loads representative states; `demo --clear` removes only those records.
- `switchboardctl link` repairs a GNOME Terminal association from inside the intended tab.
- `switchboardctl seen`, `unread`, and `dismiss` update session read-model state.

Hook input has a 512 KiB safety limit. Normal Codex and Claude hook delivery uses a 450 ms client deadline and fails silently unless strict/debug behavior is requested, preventing an unavailable dashboard from blocking the coding agent.

## Runtime configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `SWITCHBOARD_HOME` | Override the private runtime-state directory | XDG state location |
| `SWITCHBOARD_HOST` | HTTP bind host | `127.0.0.1` |
| `SWITCHBOARD_PORT` | HTTP port | `43117` |
| `SWITCHBOARD_RECENT_HOURS` | Closed-session retention window | `24` |
| `SWITCHBOARD_MAX_RECENT` | Maximum rows in Recent | `20` |
| `SWITCHBOARD_DISCOVERY_INTERVAL_MS` | Linux process scan interval | `2500` |
| `SWITCHBOARD_ACTIVITY_IDLE_MS` | Quiet interval before inferred Idle | `7500` |
| `SWITCHBOARD_NATIVE_WAYLAND` | Opt into Electron native Wayland | unset; XWayland preferred |
| `SWITCHBOARD_DEVTOOLS` | Enable Electron renderer developer tools | unset |
| `SWITCHBOARD_DEBUG` | Print optional integration/discovery diagnostics | unset |

Configuration parsing rejects partially numeric, overflowing, unsafe, or structurally invalid values instead of silently accepting them.

## Repository structure

```text
desktop/                    Electron main process, preload bridge, and window behavior
docs/                       Architecture and portfolio/project documentation
integrations/
  claude/                   Claude Code hook template
  codex/                    Codex hook template
  gnome-shell/              GNOME focus/route extension
  opencode/                 OpenCode event-plugin source template
  systemd/                  Optional user-service template
scripts/                    Setup, uninstall, installers, desktop runner, and checks
src/
  adapters/                 Harness-specific event translators
  bin/                      Daemon, TUI, and control CLI entry points
  discovery/                Linux process discovery and inference
  client.js                 HTTP client used by CLI and TUI
  config.js                 Runtime validation and private state setup
  domain.js                 Normalized event contract and sanitization
  focus.js                  Validated application/terminal activation
  reducer.js                Canonical session-state transitions
  runtime.js                Daemon composition and lifecycle
  server.js                 Local assets, JSON API, and SSE
  store.js                  SQLite persistence and read model
test/                       Node test suite covering all major layers
web/                        Desktop renderer HTML, CSS, and JavaScript
```

## Testing and quality strategy

The project uses Node's built-in test runner. At the time this document was prepared, all **113 tests passed**.

Coverage is behavior-oriented and includes:

- adapter mappings and content stripping;
- reducer precedence, attention lifetime, interruption, unread, and closure semantics;
- SQLite event deduplication, persistence, migrations, provisional/native merging, PID reuse, retention, and collapse rules;
- local API authentication, asset serving, actions, and body handling;
- exact process matching, foreground filtering, nested-agent suppression, lifecycle parsing, counter inference, and startup reconciliation;
- focus-provider validation and command construction for tmux, WezTerm, kitty, Zellij, GNOME Terminal, and VS Code;
- GNOME bridge parsing and behavior;
- OpenCode plugin delivery, prompt reconciliation, and installer idempotence;
- desktop layout, always-on-top behavior, selection, and Chromium diagnostic filtering;
- TUI screen cleanup and shrinking-frame erasure;
- runtime configuration validation and unsafe-path rejection; and
- setup/uninstall ownership, atomicity, dry-run, backup, and refusal behavior.

`npm run check` adds JavaScript syntax checks and JSON parsing checks before running the full test suite.

## Notable engineering decisions

### One reducer, two clients

Both user interfaces consume the daemon's read model. State fixes are made once in adapters, discovery, the reducer, or the store. This prevents the desktop and TUI from disagreeing about the same session.

### Explicit events over silence

Unread completion is created only by a reliable lifecycle transition. Counter quietness is deliberately weaker and produces Idle. This reduces false notifications during silent tools, network waits, or long model calls.

### Structured focus coordinates over heuristics

The system validates and activates IDs already provided by terminals, multiplexers, process ancestry, or the compositor. It avoids title matching, terminal scraping, input injection, and shell command construction.

### Local lifecycle metadata over content collection

The project can answer operational questions without becoming a repository of prompts and answers. Content exclusion is implemented at integration boundaries and reinforced by tests.

### Conservative installation ownership

Setup records exact entries it owns. Uninstall compares those exact objects rather than deleting anything that merely resembles a Switchboard hook. This is slower to implement than overwriting configuration, but it is much safer for developer machines.

### Process discovery as fallback and reconciliation

Discovery makes the product useful immediately, but its signals are labeled with lower confidence. Native adapters remain the authoritative source for completion, errors, interruption, and human attention.

### Durable event log plus materialized session projection

Storing both events and current sessions provides inexpensive snapshot reads, deduplication, audit-friendly recent activity, and a clear place to apply reducer logic.

## Key technical challenges addressed

### Avoiding duplicate identities

The daemon may learn about a process before the harness reveals its durable session ID. Transactional provisional-to-native merging, start-time tolerance, and read-model collapse handle this without presenting two rows.

### Distinguishing attention from work

Harnesses emit generic busy, tool, idle, and notification signals that can be misleading. The adapters and reducer preserve an explicit prompt until a trustworthy resolution arrives and do not classify a pending tool as human attention.

### Preserving interruption semantics

Some harnesses emit ordinary idle cleanup after an aborted turn. Adapter/plugin suppression plus reducer guards prevent those cleanup events from generating a false successful completion.

### Focusing existing windows on Linux

Wayland and GNOME intentionally restrict applications from arbitrarily raising other windows. The project combines stable terminal metadata with a narrowly scoped Shell extension instead of using unsafe title guesses or opening duplicates.

### Reliable OpenCode prompt delivery

Permission and question events are critical but can occur in bursts. A persistent ordered stream, replayable critical queue, bounded retries, coalescing, and periodic pending-list reconciliation make prompt state resilient to transient delivery problems.

### Exception-safe full-screen terminal rendering

The TUI owns terminal modes that must always be restored. Centralized acquisition/release, process exit hooks, alternate-screen cleanup, and tested tmux suspension prevent a broken shell after failure.

## Current limitations and honest scope

- Linux is the supported platform. The daemon's architecture is portable, but discovery and focus integrations are Linux-specific.
- The bundled GNOME Shell connector currently targets GNOME 42–44.
- Exact jumps depend on the host exposing stable structured identifiers and required command-line tools.
- kitty requires remote control and a Unix listen address.
- Zellij routing attaches a terminal to a session rather than selecting an exact pane in an already running client.
- The OpenAI VS Code extension does not expose a public external command for selecting an exact Codex conversation when several threads share one editor window. Switchboard focuses the correct window, not necessarily a particular thread inside it.
- Native Wayland can weaken Electron always-on-top behavior, so XWayland is the default desktop backend.
- Process-only activity remains an estimate until native hooks or plugins are installed.
- The service is local and single-user; it is not designed for remote or public exposure.
- The TUI expects an already running daemon, while the Electron app can start and own one automatically.
- Read/unread state is shared through the daemon's session projection rather than synchronized independently per device or user.
- The package is still private and versioned `0.1.0`; the Agent Deck rename is incomplete.

These constraints are useful portfolio context because they show where the implementation deliberately stops rather than suggesting unsupported behavior.

## Extension points

### Adding another coding harness

A new harness can be added without redesigning the clients:

1. Add the stable harness slug to the domain allowlist.
2. Implement an adapter that translates native lifecycle signals into the normalized event contract.
3. Export the adapter from the adapter registry.
4. Add a hook, plugin, or bridge under `integrations/`.
5. Optionally add exact Linux executable detection.
6. Optionally add a validated focus provider.
7. Add fixtures covering work, attention, resolution, completion, interruption, error, and closure.

The reducer changes only if the new harness introduces a genuinely cross-harness semantic.

### Possible future product work

Reasonable future directions, not present features, include:

- a coordinated Agent Deck rename and migration plan;
- support for newer GNOME Shell versions and other Linux desktop environments;
- additional coding harness adapters;
- platform-specific discovery and focus layers for macOS or Windows;
- configurable notification policies built on the same canonical state model;
- stronger per-client acknowledgement semantics if multiple independent clients need separate unread queues;
- packaging and signed release artifacts; and
- aggregate, content-free productivity analytics if they can preserve the project's privacy boundary.

## Portfolio significance

This project demonstrates more than desktop UI construction. It combines:

- event-driven architecture;
- adapter and reducer design;
- local systems/process inspection;
- transactional data modeling;
- real-time local transport;
- native desktop lifecycle management;
- terminal UI engineering;
- Linux window-system integration;
- security-boundary design;
- privacy-by-design data minimization;
- safe developer-tool installation; and
- broad automated behavioral testing.

It is especially strong as a portfolio project for systems-oriented full-stack, developer tooling, platform engineering, desktop application, or AI infrastructure roles because the value is visible to users while the implementation includes substantial reliability and operating-system integration work.
