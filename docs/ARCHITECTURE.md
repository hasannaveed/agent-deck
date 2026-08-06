# Architecture

Agent Switchboard has three boundaries: signal ingestion, state reduction, and
presentation. The native Electron pane and terminal client consume the same read
model, so adding a harness does not add presentation-specific state logic. The
Electron process reuses an existing daemon or owns an embedded daemon for its
lifetime.

```text
Codex hooks ────────────┐
Claude Code hooks ──────┼─> adapter -> normalized event -> reducer -> SQLite
OpenCode plugin ────────┤                                      │
Linux /proc discovery ──┘                                      ├─> HTTP + SSE -> Electron renderer
                                                               └─> HTTP       -> TUI
                                                                        │
terminal coordinates ───────────────────────────────────────────────────┴─> focus provider
```

The Codex translator also understands app-server notification shapes, leaving a
clean path for a future long-lived app-server connector; the shipped integration
uses lifecycle hooks so it can observe existing CLI sessions without owning them.

## Session state is factored

A session does not have one mutable status string. Its stored state has
independent dimensions:

- `presence`: `live` or `closed`;
- `activity`: `working`, `idle`, or `unknown`;
- `attention`: `required` or `none`, plus request metadata;
- `unread`: whether a completion sequence is newer than its seen sequence;
- `errorKind` and `errorSummary`;
- `telemetry` and `confidence`: whether the signal came from a native event,
  hook, process scan, or derivation.

The UI derives one primary state using this precedence:

```text
error > needs_attention > working > unread > idle > unknown > recent
```

Working intentionally outranks unread: if a user starts another turn before
opening an earlier completion, the current activity is the most useful signal.
A human-initiated new turn also acknowledges earlier completion sequences.

## Normalized event contract

Adapters emit schema version 1 objects with these stable fields:

```json
{
  "schemaVersion": 1,
  "eventId": "native durable id or generated UUID",
  "harness": "codex",
  "nativeSessionId": "thread/session id",
  "kind": "attention_requested",
  "nativeType": "item/commandExecution/requestApproval",
  "occurredAt": 1700000000000,
  "telemetry": "native",
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
    "terminalInstance": "/tmp/tmux-1000/default"
  },
  "attention": {
    "kind": "approval",
    "requestId": "request-1",
    "summary": "Approval requested for Bash"
  }
}
```

Valid `kind` values are `session_started`, `process_seen`, `process_gone`,
`work_started`, `activity_idle`, `attention_requested`, `attention_resolved`,
`work_completed`, `session_error`, and `session_ended`.

Event IDs are deduplicated per harness. Session keys are hashes of harness plus
native session ID, so raw IDs do not appear in URLs. When a native event includes
the same PID as a process-discovered provisional session, the store merges their
history instead of showing two rows.

The Linux fallback only admits harness processes that own the foreground process
group of a controlling terminal. It prefers non-content terminal status metadata
when a harness exposes it (for example Codex's tmux pane title). For OpenCode it
queries only lifecycle fields from the local database: assistant completion and
tool `pending`/`running` status. It never selects message or tool content. Other
cases fall back to CPU and I/O counters. These signals remain marked as
low-confidence process telemetry, so native hook events take precedence.
Stopped/background jobs and headless editor services do not
masquerade as open sessions. On startup, discovery reconciles persisted
process-only rows against `/proc`; transition IDs are unique so a stopped process
can be reopened correctly if it is later resumed. The read model collapses
superseded process records that share a harness, workspace, and terminal while
retaining their underlying event history.

A pending tool is still agent work; it is not an attention request. The fallback
only derives `needs_attention` from an unambiguous human-input status such as
Codex's `Action Required`. OpenCode permission and question states come from its
explicit plugin events.

## Retention and acknowledgement

The read model always includes live sessions and unresolved error, attention, or
unread signals. It includes ordinary closed sessions only within the recent time
window, and caps that recent group independently. Dismissal hides a closed row;
new native activity automatically brings it back.

A successful desktop or TUI jump advances `seenSeq` to `completionSeq`.
Inspecting a row, merely moving keyboard selection, or attempting an unavailable
jump does not acknowledge it.

## Desktop trust and focus boundary

The renderer receives a narrow preload bridge and sends only a hashed session
identifier when a user activates a row. The Electron main process fetches the
trusted session record from the daemon, validates its terminal target, and
invokes commands with argument arrays rather than a shell. Navigation, new
windows, and renderer permission requests are denied.

The TUI fetches the same trusted detail record and passes it through the same
argument-array focus providers. When it is attached to the same tmux server as
the target, it selects the existing pane in the current client instead of
launching another terminal.

Focus providers are deliberately terminal-specific. tmux and Zellij open an
attached graphical terminal when needed, but tmux first reuses any client already
attached to the target session. WezTerm uses its CLI pane activation; kitty
requires its explicit remote-control Unix socket. Unsupported terminals remain
visible but are reported as non-focusable instead of using title matching or
injecting input.

## Adding a harness

To add another harness without changing the daemon or either UI:

1. Add its stable slug to `HARNESSES` in `src/domain.js`.
2. Add a translator in `src/adapters/` that converts native events into the
   normalized contract; keep prompts and transcript content out of the event.
3. Export it from `src/adapters/index.js`.
4. Add an integration bridge or plugin under `integrations/`.
5. Optionally extend exact executable matching in `src/discovery/linux.js`.
6. Optionally add a validated focus provider in `src/focus.js`.
7. Add adapter fixtures that cover work, completion, attention resolution,
   errors, and session closure.

The reducer should only change when a new cross-harness semantic is needed.

## Local security model

The service listens on `127.0.0.1` unless explicitly configured otherwise.
Reads are same-origin and contain lifecycle metadata; writes require a 256-bit
token created in the state directory with mode `0600`. The sandboxed Electron
renderer obtains the token from its same-origin server. Responses deny framing,
cross-origin resource sharing, external scripts, and referrers. This is a local
single-user tool, not a multi-tenant or remotely exposed service.
