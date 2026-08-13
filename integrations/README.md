# Native harness integrations

Switchboard discovers live processes without configuration, but native hooks are
what make `working`, `interrupted`, `needs attention`, `unread`, and `error` exact.

These templates only send lifecycle metadata to the local daemon. The bridge
does not forward prompts, assistant responses, tool input, command text, or
transcripts. If the daemon is unavailable, `switchboardctl emit` exits silently
so it cannot block the harness.

## Before merging a template

The recommended path is the unified, ownership-aware installer:

```bash
npm ci
npm run setup
```

It validates both JSON configurations before changing either one, appends only
missing matcher groups, records the exact entries it owns, and makes a one-time
backup of each existing file under
`~/.local/state/agent-switchboard/install-backups`. Re-running it is safe. It
will stop without touching malformed JSON, a symbolic-link configuration, or an
unrelated desktop/plugin destination.

Use `npm run setup -- --dry-run` to preview destinations. Use
`npm run uninstall` to remove only exact entries created by setup; existing and
subsequently edited entries are preserved. The manual steps below are useful
when a config is intentionally managed through a symlink or another dotfile
system.

## Manual template installation

1. Install this package so `switchboardctl` is on `PATH`, or replace the command
   in the template with an absolute command such as
   `node /absolute/path/src/bin/switchboardctl.js`.
2. Start `switchboardd` and run `switchboardctl doctor`.
3. Merge the relevant entries into existing configuration. Do not replace an
   existing `hooks` object wholesale.

## Codex

Merge `codex/hooks.json` into `~/.codex/hooks.json`. Codex combines matcher
groups, so preserve any groups already present. Codex may ask you to review and
trust newly discovered hooks. Use `/hooks` to inspect them; see the official
[Codex hooks reference](https://learn.chatgpt.com/docs/hooks).

## Claude Code

Merge `claude/settings.json` into `~/.claude/settings.json`. Preserve existing
settings and append these hook matcher groups to matching event arrays. See the
official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

## OpenCode

Install the native event bridge with:

```bash
npm run opencode:install
```

The installer writes `~/.config/opencode/plugins/switchboard.js` with absolute
paths to this checkout, so it does not depend on `switchboardctl` being on
`PATH`. At startup the plugin also checks OpenCode's pending permission and
question lists, covering a prompt that was raised just before a restart. It uses
OpenCode's event-plugin API; see the official
[OpenCode plugin reference](https://opencode.ai/docs/plugins/).

The plugin also marks tool-launched shells as child work. It adds that marker to
tmux's runtime `update-environment` list so an OpenCode process launched by a
parent agent in a detached tmux session is suppressed as nested work. No command
text is inspected or stored.

Restart already-running harness sessions after changing integration files.

## GNOME desktop switching on Wayland

GNOME Terminal supplies a stable screen object path to child processes, but it
does not expose a public method that raises that existing screen. Install the
bundled GNOME Shell bridge on GNOME 42–44:

```text
npm run gnome:install
```

New Codex, Claude Code, and OpenCode processes are linked automatically while
their launch tab is focused. This includes the host GNOME Terminal tab for an
attached tmux client. Native `SessionStart` and user-prompt events also refresh
the route at safe foreground moments. Background events never change a route.
The same connector validates and activates an existing VS Code editor window
for a Codex extension-host process. No manual link is needed for VS Code. A sole
editor window is raised directly; if several are open, Switchboard maps the
extension host to the exact renderer. Activation failures are reported instead
of silently opening the workspace behind another foreground application.
When the desktop pane is pinned, the connector also makes it sticky and raises
it above the terminal after a jump without taking keyboard focus from the agent.

Manual linking is only a recovery path for an agent that predates the connector,
or a tab that was moved or reordered. Try to open that session once, focus the
target terminal tab, then choose **Repair terminal jump** in the desktop pane.
Alternatively, run `switchboardctl link` inside that tab. The bridge stores only
the GNOME D-Bus service, screen and window paths, and tab index; it does not
inspect terminal contents.

GNOME may require a logout and login before loading a newly installed local
extension. The installer prints the exact enable command when that is necessary.

## Run the daemon at login (optional)

After `switchboardd` is on `PATH`, install the included user service:

```text
mkdir -p ~/.config/systemd/user
cp integrations/systemd/agent-switchboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-switchboard.service
```

The service is a template for Linux systems using systemd; review its executable
path and hardening settings before enabling it.
