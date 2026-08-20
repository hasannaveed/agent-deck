# Agent Switchboard

One local pane for active and recent Codex, Claude Code, and OpenCode sessions.
Switchboard surfaces the sessions that matter now—working, waiting for you,
finished but unread, idle, or errored—without turning your entire agent history
into an inbox.

It includes:

- a native Electron desktop pane with always-on-top, tray, and hide/show controls;
- click-to-jump routing for VS Code-hosted Codex sessions, tmux, WezTerm,
  kitty, Zellij, and GNOME Terminal;
- an interactive terminal UI with a prominent harness column;
- a local SQLite event store and Server-Sent Events stream;
- native adapters for Codex, Claude Code, and OpenCode;
- a dependency-free daemon and TUI (the desktop shell uses Electron);
- Linux process discovery with low-confidence working/idle inference when hooks
  are not yet installed.

## Install on a new machine

The current supported target is Linux. The daemon and TUI can run without a
graphical desktop. The native desktop pane needs a graphical session, and exact
jumping to ordinary GNOME Terminal tabs or existing VS Code windows requires
the bundled connector on GNOME Shell 42–44.

### Quick install (recommended)

Install Git and Node.js 22.5 or newer, then run:

```bash
git clone https://github.com/hasannaveed/agent-deck.git
cd agent-deck
./install.sh
```

That is the complete normal installation. The installer downloads the locked
npm dependencies, safely merges the coding-harness integrations, installs the
desktop launcher and supported GNOME connector, enables startup after login,
runs the built-in doctor, and opens Agent Switchboard. It changes only the
current user's files and never uses `sudo`.

The command is safe to run again after an update. It preserves existing Codex
and Claude settings and refuses malformed, linked, or foreign configuration
destinations instead of overwriting them.

Common alternatives are:

```bash
./install.sh --dry-run          # preview every managed destination
./install.sh --no-autostart     # install without starting at login
./install.sh --no-launch        # install without opening the pane now
./install.sh --skip-gnome       # skip the optional GNOME connector
./install.sh --help             # show every installer option
```

If the shell file cannot be executed because its executable bit was lost while
copying or extracting the repository, use the equivalent npm command:

```bash
npm run install:user
```

After installation, restart coding-agent sessions that were already open. In
Codex, open `/hooks` once and trust the new user hooks. If the installer reports
that GNOME is still using an older connector, log out of the desktop session and
back in once.

### Manual installation and troubleshooting

The steps below explain the prerequisites and individual setup stages. Most
users can use the quick installer above instead.

### 1. Install the prerequisites

You need:

- Git;
- Node.js 22.5 or newer and its bundled `npm` command;
- a supported coding harness—Codex, Claude Code, or OpenCode—already installed;
- a graphical Linux desktop if you want the native desktop pane;
- `gnome-shell` and `gnome-extensions` if you want the bundled terminal and
  application-window connector on GNOME 42–44.

tmux, WezTerm, kitty, and Zellij are optional. Install only the terminal tools
you actually use. Switchboard installs integrations for the harnesses but does
not install the harness applications themselves.

Confirm the required runtime before continuing:

```bash
node --version
npm --version
```

If Node.js is missing or older than 22.5, install a current release through your
normal package manager or Node version manager first.

### 2. Clone the repository or your fork

To use the main repository:

```bash
git clone https://github.com/hasannaveed/agent-deck.git
cd agent-deck
```

If you created a GitHub fork, clone your fork instead:

```bash
git clone https://github.com/YOUR-ACCOUNT/agent-deck.git
cd agent-deck
```

Choose the checkout location before setup and keep it there. Installed hooks,
the desktop launcher, and the OpenCode plugin contain absolute paths back to
this checkout. If you later move it, rerun `npm run setup` from the new location.
Run the dependency installation and setup steps separately on every device;
cloning the repository alone does not install that device's user integrations.

### 3. Install dependencies and preview setup

```bash
npm ci
npm run setup -- --dry-run
```

The dry run is optional but useful on a new machine: it lists every file and
integration setup intends to manage without changing or launching anything.

### 4. Install the integrations and desktop launcher

For the normal installation, including desktop autostart after login, run:

```bash
npm run setup -- --autostart
```

Omit `--autostart` if you prefer to start the desktop pane manually:

```bash
npm run setup
```

Run setup from a terminal inside the logged-in graphical session when using
GNOME. This gives the installer access to the correct desktop session and lets
it detect, install, and enable the GNOME desktop connector. Running setup over
SSH or from a headless shell still installs the harness integrations, but it may
skip the GNOME connector and cannot open the desktop pane. You can run
`npm run gnome:install` later from the GNOME desktop session.

`setup` safely merges the Codex and Claude Code lifecycle hooks, installs the
OpenCode event plugin, creates the application-menu launcher, installs the GNOME
desktop connector when a supported GNOME desktop is detected, runs the doctor,
and opens the desktop pane. It changes only the current user's files; it does
not use `sudo`, install a system service, or edit shell startup files.

Existing Codex and Claude settings are preserved and their hook arrays are
appended to rather than replaced. Before the first edit, setup saves a copy under
`~/.local/state/agent-switchboard/install-backups`. It refuses malformed JSON,
symbolic-link configs, and unrelated files occupying a Switchboard destination
instead of overwriting them.

### 5. Complete the one-time harness and GNOME steps

After setup:

1. Restart any Codex, Claude Code, or OpenCode sessions that were already open.
2. Start Codex, open `/hooks`, review the new user hooks, and trust the
   Switchboard entries once. The installer intentionally cannot bypass this
   user confirmation.
3. On GNOME, follow the setup output. If it says the connector is pending or
   that GNOME Shell is still running an older connector protocol, save your
   work and log out of the desktop session and back in once. Locking the screen
   is not enough; rebooting also reloads the connector.
4. After that login, start the desktop pane again unless `--autostart` already
   opened it. Restart any TUI that survived in tmux so it loads the installed
   code from this checkout.
5. Verify the completed installation:

   ```bash
   npm run doctor
   ```

6. On GNOME, verify the loaded desktop connector:

   ```bash
   gdbus call --session \
     --dest com.skylabs.AgentSwitchboard.GnomeBridge \
     --object-path /com/skylabs/AgentSwitchboard/GnomeBridge \
     --method com.skylabs.AgentSwitchboard.GnomeBridge1.Ping
   ```

   The current connector replies with `('2',)`. A lower version means the new
   files are installed but GNOME Shell still needs a full logout and login.

If GNOME still reports that the connector is not running after logging back in,
run these from the graphical session:

```bash
npm run gnome:install
gnome-extensions enable agent-switchboard@skylabs-ai.com
```

Follow any logout instruction printed by `npm run gnome:install`, then run the
`gdbus` verification above again. The GNOME connector enables exact switching
to ordinary GNOME Terminal windows and tabs as well as existing VS Code windows.
OpenCode permission and question prompts appear as `NEEDS YOU`; ordinary
pending or running tools remain `WORKING`.

### 6. Start the desktop pane, TUI, or both

The setup command normally opens the desktop pane immediately. Later, launch it
from the application menu or from this checkout:

```bash
npm run gui
```

The desktop process starts the local daemon when one is not already running. To
use the TUI alongside it, open another terminal and run:

```bash
npm run tui
```

To run only the daemon and TUI without the desktop pane, use two terminals:

```bash
# Terminal 1
npm run daemon

# Terminal 2
npm run tui
```

Do not start a second standalone daemon when the desktop pane already owns one;
both clients should reuse the same daemon at `127.0.0.1:43117`.

Start a supported coding-agent session after setup. It should appear after its
native start event or within the next Linux discovery scan, normally 2.5 seconds.
For a full code and configuration check, run:

```bash
npm run check
```

The window stays above normal windows, can hide to the system tray, and
remembers its normal expanded size. `Ctrl+Shift+Space` toggles it. Accidental
maximize or fullscreen actions are returned to the remembered pane size instead
of replacing it. On Linux, the pane remains keyboard-focusable while staying
above other applications and across workspaces. Use `↑`/`↓` (or `j`/`k`) to
select a visible session and `Enter` to jump to it.

To preview every state, run `node src/bin/switchboardctl.js demo`. The demo is
optional and is never loaded by normal startup; live Linux process discovery
starts automatically.

The individual component installers remain available for development or a
manual repair:

```bash
npm run desktop:install
npm run desktop:install -- --autostart
npm run gnome:install
npm run opencode:install
```

For convenient commands during development, run `npm link` once and then use
`switchboardd`, `switchboard`, and `switchboardctl` directly.

### Updating an existing installation

After pulling a newer revision on any device, refresh its dependencies and
machine-local integrations from that same checkout:

```bash
git pull --ff-only
./install.sh --no-launch
```

Follow the connector output exactly. A connector upgrade may require one logout
and login because GNOME Shell keeps the old extension code in memory. Then
restart the GUI, TUI, and any standalone daemon so each process loads the new
code. Existing runtime state and session history are preserved.

## Connect real harnesses

Process discovery estimates state from non-content terminal status metadata and
OpenCode lifecycle fields when available, then falls back to process activity
counters. For Codex, it also reads only the bounded lifecycle records in the
live rollout tail so a human interruption can override a stale terminal title;
prompt, reasoning, tool, and assistant-content records are ignored and never
persisted. Hooks provide exact activity plus attention, unread, and error
states. Run:

```bash
switchboardctl integrations
```

Queued or pending tools count as working. `NEEDS YOU` is reserved for an explicit
human-input signal such as a permission request, question, authentication step,
or Codex's `Action Required` status.

For Codex inside tmux, a pending approval is considered resolved after the pane
has returned from `Action Required` to a working status for two consecutive
discovery scans. This prevents an approved long-running command from remaining
in `NEEDS YOU`; the rule never clears questions or clarification requests.

OpenCode instances launched from an agent tool shell are treated as nested work
and folded into their top-level parent instead of becoming additional rows. The
integration forwards this ownership marker through detached tmux sessions
without inspecting shell commands.

Codex app-server processes launched by the official VS Code extension are
identified from their extension executable and VS Code extension-host ancestry.
They appear as **Codex · VS Code** rather than as an unknown terminal process.

A reliable harness transition from `WORKING` to finished becomes `UNREAD` until
you successfully jump to that session or mark it seen. Counter-only process
sampling remains conservative: a process that merely goes quiet becomes `IDLE`,
so long silent tools do not create false unread results.

A turn explicitly stopped by the human becomes `INTERRUPTED`. It does not count
as a successful completion, create an unread result, or require attention. The
state remains visible until the next turn starts.

Then merge the relevant template from [`integrations/`](./integrations/README.md)
into each harness configuration. The hook bridge sends lifecycle metadata only;
it does not persist prompts, responses, tool inputs, command text, or transcripts.
Hook delivery has a 450 ms deadline and fails silently, so an offline daemon does
not interfere with the harness.

## Commands

```text
./install.sh                       recommended complete user installation
npm run install:user               npm equivalent of ./install.sh
npm run setup                      safely install user integrations and launcher
npm run setup -- --autostart       also start the desktop pane after login
npm run setup -- --dry-run         preview setup without changing anything
npm run uninstall                  remove only setup-owned integration entries
npm run uninstall -- --dry-run     preview uninstall without changing anything
npm run uninstall -- --purge       also remove runtime data after Switchboard stops
npm start                           open the native desktop pane
npm run daemon                      run only the local daemon
npm run tui                         open the interactive terminal UI
npm run gnome:install               install the GNOME desktop focus connector
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

The normal uninstall is deliberately conservative:

```bash
npm run uninstall -- --dry-run
npm run uninstall
```

It removes only the exact hook entries recorded by setup and only files carrying
Switchboard's ownership marker. Existing settings, unrelated hooks and plugins,
the checkout, dependencies, and runtime history are preserved. If an installed
hook entry was edited after setup, uninstall reports and preserves it for manual
review. After quitting the desktop pane and daemon, pass `--purge` to remove the
runtime database, preferences, manifest, and setup backups too.

In the desktop pane, click a row or press `Enter` to jump to it; press `I` or use
the row's colored state label to inspect signals without acknowledging the session.
Successful jumps leave the Switchboard pane visible and mark unread work as seen.
The pane opens at the bottom right. Minimize, hide, and the window close control
collapse it into a compact status dock there; click the dock to restore the full
pane. The collapsed and expanded panes both stay in front; there is no pin toggle
to disable accidentally. Maximizing or entering fullscreen restores the last
normal pane size instead of replacing it.
On Linux the small desktop pane uses XWayland by default because Electron's native
Wayland backend does not support programmatic z-order changes. Set
`SWITCHBOARD_NATIVE_WAYLAND=1` only if you prefer native Wayland over guaranteed
always-on-top behavior.

TUI keys are `↑`/`↓` or `j`/`k` to move, `Enter` to jump to the selected
session, `i` to inspect without acknowledging, `m` to toggle read state, `d` to
dismiss a closed session, `1`–`6` to filter, `r` to refresh, and `q` to quit.
Every row identifies `CODEX`, `CLAUDE CODE`, or `OPENCODE` in a dedicated column;
VS Code-hosted sessions add a compact `VS` host marker.
The TUI starts on the `Active` view; recently closed sessions remain available
under `Recent` instead of crowding the live-session list. Process-only discovery
rows briefly show `OPEN` while the activity sampler establishes a baseline, then
move between inferred `WORKING` and `IDLE`. Native integration signals replace
those estimates with exact `WORKING`, `IDLE`, `NEEDS YOU`, `UNREAD`, or `ERROR`
states.

## Session jumping

Switchboard records a structured application or terminal target alongside each live session:

- VS Code: maps the Codex extension-host process to its existing editor window
  and activates that window through the GNOME connector. A sole editor window
  is raised immediately; with several windows, Switchboard resolves the exact
  renderer first. A detected live host is never replaced by a background-only
  workspace launch when activation fails;
- tmux: selects the exact pane, focuses an existing attached client's terminal,
  and attaches through the current TUI terminal only as a fallback;
- WezTerm: activates the exact pane through `wezterm cli` and preserves its GUI
  socket when available;
- kitty: focuses the exact window when kitty was started with remote control and
  a `KITTY_LISTEN_ON` Unix socket;
- Zellij: opens a graphical terminal attached to the matching Zellij session.
- GNOME Terminal: uses its inherited screen ID plus a small GNOME Shell
  extension to activate its Wayland window and select its tab.

The VS Code route raises the correct existing editor window. Legacy records that
do not contain an application-host PID may reopen their recorded workspace. The
OpenAI extension does not expose a public external command for selecting one
exact Codex conversation, so Switchboard does not claim to restore a particular
thread when several threads share that editor window.

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
5. interrupted;
6. open/idle;
7. recently closed.

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
