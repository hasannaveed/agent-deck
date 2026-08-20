# Agent Deck / Agent Switchboard — Project Summary

## One-line description

Agent Switchboard is a local Linux desktop and terminal dashboard that monitors Codex, Claude Code, and OpenCode sessions, highlights work that needs attention, and jumps back to the exact existing terminal pane, tab, or VS Code window.

## Short project description

Agent Switchboard is a privacy-conscious developer tool for managing multiple AI coding-agent sessions from one place. It combines native harness events with conservative Linux process discovery, normalizes them into shared states such as Working, Needs You, Unread, Interrupted, Idle, and Error, and presents the same live queue through an Electron desktop pane and a keyboard-first terminal UI. A validated focus layer can return the user to supported tmux, WezTerm, kitty, Zellij, GNOME Terminal, or VS Code environments without reading terminal or conversation content.

## High-level feature summary

- Monitors OpenAI Codex, Claude Code, and OpenCode sessions.
- Shows live working, attention, unread, interruption, idle, error, and recent states.
- Provides both an always-on-top Electron pane and an independent terminal UI.
- Streams real-time updates from a local Node.js daemon backed by SQLite.
- Discovers foreground Linux sessions even before native hooks are installed.
- Jumps to validated existing terminal panes, tabs, sessions, and VS Code windows.
- Tracks unread completions and acknowledges them only after a successful jump or explicit action.
- Avoids duplicate rows by merging process-discovered and native session identities.
- Stores lifecycle and routing metadata without collecting prompts, responses, terminal text, or command contents.
- Includes a one-command `./install.sh` path plus safe, idempotent setup and uninstall flows for harness hooks, the OpenCode plugin, desktop launchers, and the GNOME connector.
- Is covered by 113 automated tests across state logic, storage, discovery, focus routing, desktop behavior, TUI behavior, integrations, security, and installers.

## Technology stack

- JavaScript with native ES modules
- Node.js 22.5+
- Built-in `node:sqlite`
- Built-in Node HTTP server and Server-Sent Events
- Electron desktop shell
- HTML, CSS, and vanilla browser JavaScript
- Linux `/proc` process discovery
- GNOME Shell/GJS and D-Bus integration
- tmux, WezTerm, kitty, Zellij, GNOME Terminal, and VS Code routing
- Node's built-in test runner

## Architecture in one paragraph

Codex and Claude hooks, an OpenCode plugin, and Linux process discovery generate lifecycle evidence. Harness adapters translate that evidence into a versioned common event contract. A deterministic reducer produces the canonical session state, and a transactional SQLite store persists both events and current session projections. A loopback HTTP API exposes JSON snapshots and an SSE change stream to the Electron renderer and terminal client, while trusted native code validates stored terminal/application coordinates before performing any focus action.

## Resume-ready project entry

**Agent Switchboard — Local AI Coding-Session Dashboard**

*Node.js, Electron, SQLite, Linux, SSE, GNOME Shell, D-Bus*

Built a Linux-first desktop and terminal control surface for monitoring concurrent Codex, Claude Code, and OpenCode sessions. Designed an event-normalization and reducer pipeline for accurate working, attention, unread, interruption, idle, error, and recent states; added privacy-preserving `/proc` discovery and native lifecycle integrations; and implemented validated navigation to existing terminal panes, GNOME tabs, and VS Code windows. Added transactional SQLite persistence, a secure loopback HTTP/SSE API, conservative configuration installers, and 113 automated tests.

## Resume bullet options

- Engineered a local AI-agent operations dashboard that unifies Codex, Claude Code, and OpenCode activity across an Electron desktop pane and keyboard-first TUI.
- Designed a versioned event-adapter and deterministic reducer architecture that converts three incompatible harness lifecycles into accurate working, attention, unread, interruption, idle, error, and recent states.
- Implemented Linux `/proc` discovery, process-identity reconciliation, nested-agent suppression, and provisional-to-native session merging while avoiding prompt, transcript, and terminal-content collection.
- Built validated focus routing for tmux, WezTerm, kitty, Zellij, GNOME Terminal, and VS Code using structured targets, D-Bus, and argument-array process execution instead of title guessing or shell interpolation.
- Developed a transactional SQLite event store and secure loopback HTTP/SSE service with event deduplication, retention, bearer-token-protected mutations, strict Host validation, and real-time client updates.
- Created idempotent setup/uninstall tooling that safely merges user hook configuration, creates atomic backups, tracks owned entries, and refuses unsafe paths, symlinks, malformed JSON, or foreign destinations.
- Established a 113-test behavioral suite covering adapters, state transitions, storage, API security, Linux discovery, focus providers, Electron window management, terminal cleanup, and installers.

## Portfolio or case-study introduction

Running several coding agents in parallel creates a new coordination problem: the developer must remember which terminal belongs to which agent, which task is still working, which result finished, and which session is blocked on a question or permission. Agent Switchboard solves that problem with a local activity queue shared by a native desktop pane and terminal UI.

The technically interesting part is not simply displaying processes. Each harness describes its lifecycle differently, process activity can be ambiguous, and Linux desktop environments restrict cross-application focus. The project therefore uses explicit lifecycle adapters, a common event contract, a factored state reducer, conservative fallback inference, transactional identity reconciliation, and validated focus providers. It gains operational awareness without becoming a transcript collector.

## LinkedIn-ready version

Built **Agent Switchboard**, a Linux-first dashboard for developers running multiple AI coding agents at once. It monitors Codex, Claude Code, and OpenCode sessions from a shared Electron desktop pane or terminal UI and distinguishes what is working, waiting for input, completed but unread, interrupted, idle, or in error.

Under the hood, the project combines native lifecycle integrations with privacy-preserving `/proc` discovery, normalizes each harness into one event model, reduces those events into a canonical SQLite-backed session state, and streams updates through a local HTTP/SSE service. It can also jump back to validated tmux, WezTerm, kitty, Zellij, GNOME Terminal, and VS Code targets without reading prompts, responses, terminal text, or command contents.

The current implementation includes conservative setup/uninstall tooling, an optional GNOME Shell D-Bus connector, safe provisional-session reconciliation, and 113 passing automated tests.

## Interview talking points

- Why explicit lifecycle events are more reliable than treating process silence as completion.
- How a factored reducer prevents contradictory states and keeps two clients consistent.
- How provisional process identities merge into durable harness session IDs without duplicate rows.
- How interruption, attention, and pending-tool states differ across harnesses.
- Why structured terminal coordinates and strict validation are safer than title matching or input injection.
- How the GNOME Shell connector handles a capability that normal Wayland applications do not have.
- How content minimization was enforced at adapter boundaries and verified with tests.
- How ownership manifests and exact-object comparison make installer/uninstaller behavior safe on developer machines.

## Current scope

The current release is a local, single-user Linux tool. Exact navigation depends on supported terminal/application capabilities, the GNOME connector targets GNOME 42–44, and process-only state remains an estimate until native integrations are installed. The working product name is Agent Deck, while the implementation still uses Agent Switchboard and package version `0.1.0`.
