# Native harness integrations

Switchboard discovers live processes without configuration, but native hooks are
what make `working`, `needs attention`, `unread`, and `error` exact.

These templates only send lifecycle metadata to the local daemon. The bridge
does not forward prompts, assistant responses, tool input, command text, or
transcripts. If the daemon is unavailable, `switchboardctl emit` exits silently
so it cannot block the harness.

## Before merging a template

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
[Codex hooks reference](https://developers.openai.com/codex/config-advanced#hooks).

## Claude Code

Merge `claude/settings.json` into `~/.claude/settings.json`. Preserve existing
settings and append these hook matcher groups to matching event arrays. See the
official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

## OpenCode

Copy `opencode/switchboard.js` to the user plugin directory:

```text
~/.config/opencode/plugins/switchboard.js
```

This uses OpenCode's stable event-plugin API; see the official
[OpenCode plugin reference](https://dev.opencode.ai/docs/plugins/).

Restart already-running harness sessions after changing integration files.

## GNOME Terminal on Wayland

GNOME Terminal supplies a stable screen object path to child processes, but it
does not expose a public method that raises that existing screen. Install the
bundled GNOME Shell bridge on GNOME 42–44:

```text
npm run gnome:install
```

Then focus the target terminal tab and use **Link focused terminal** in the
desktop pane. Because the pinned pane is non-focusable on Linux, clicking the
link action records the terminal window underneath it. Alternatively, run
`switchboardctl link` from the terminal before starting Codex, Claude Code, or
OpenCode. The bridge stores only the GNOME D-Bus service, screen and window
paths, and tab index; it does not inspect terminal contents.

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
