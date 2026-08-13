const { Gio, GLib } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;

const BUS_NAME = "com.skylabs.AgentSwitchboard.GnomeBridge";
const OBJECT_PATH = "/com/skylabs/AgentSwitchboard/GnomeBridge";
const INTERFACE_XML = `
<node>
  <interface name="com.skylabs.AgentSwitchboard.GnomeBridge1">
    <method name="Ping">
      <arg type="s" direction="out" name="version"/>
    </method>
    <method name="CaptureTerminal">
      <arg type="s" direction="in" name="service"/>
      <arg type="s" direction="in" name="screen"/>
      <arg type="b" direction="in" name="allow_last"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="FocusTerminal">
      <arg type="s" direction="in" name="service"/>
      <arg type="s" direction="in" name="screen"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="FocusApplicationWindow">
      <arg type="u" direction="in" name="pid"/>
      <arg type="s" direction="in" name="application"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="RaiseSwitchboard">
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
  </interface>
</node>`;

function validService(value) {
  return /^:\d{1,10}\.\d{1,10}$/.test(String(value || ""));
}

function validScreen(value) {
  return /^\/org\/gnome\/Terminal\/screen\/[a-zA-Z0-9_]{1,160}$/.test(String(value || ""));
}

function validWindowPath(value) {
  return /^\/org\/gnome\/Terminal\/window\/\d{1,12}$/.test(String(value || ""));
}

class SwitchboardBridge {
  constructor() {
    this._targets = new Map();
    this._lastTerminals = new Map();
    this._stateDirectory = GLib.build_filenamev([GLib.get_user_state_dir(), "agent-switchboard"]);
    this._statePath = GLib.build_filenamev([this._stateDirectory, "gnome-terminal-targets.json"]);
    this._focusSignal = 0;
    this._dbusObject = null;
    this._nameId = 0;
  }

  enable() {
    this._loadTargets();
    this._focusSignal = global.display.connect("notify::focus-window", () => this._rememberFocusedTerminal());
    this._rememberFocusedTerminal();
    this._dbusObject = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
    this._dbusObject.export(Gio.DBus.session, OBJECT_PATH);
    this._nameId = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
    );
  }

  disable() {
    if (this._focusSignal) global.display.disconnect(this._focusSignal);
    this._focusSignal = 0;
    if (this._dbusObject) this._dbusObject.unexport();
    this._dbusObject = null;
    if (this._nameId) Gio.bus_unown_name(this._nameId);
    this._nameId = 0;
    this._targets.clear();
    this._lastTerminals.clear();
  }

  Ping() {
    return "2";
  }

  CaptureTerminal(service, screen, allowLast) {
    if (!validService(service) || !validScreen(screen)) {
      return [false, "The terminal did not provide a valid GNOME screen identifier."];
    }
    if (!this._screenExists(service, screen)) {
      return [false, "That GNOME Terminal screen is no longer running."];
    }

    let terminal = this._focusedTerminal();
    if ((!terminal || terminal.service !== service) && allowLast) {
      terminal = this._lastTerminals.get(service) || null;
      if (terminal) {
        const tab = this._readActiveTab(terminal.service, terminal.windowPath);
        if (tab) terminal = { ...terminal, tabIndex: tab.index };
      }
    }
    if (!terminal || terminal.service !== service) {
      return [
        false,
        "Focus the target GNOME Terminal tab first, then choose Repair terminal jump again.",
      ];
    }

    const target = {
      service,
      screen,
      windowPath: terminal.windowPath,
      tabIndex: terminal.tabIndex,
      linkedAt: Date.now(),
    };
    this._targets.set(this._key(service, screen), target);
    this._lastTerminals.set(service, target);
    this._saveTargets();
    return [true, "Connected this session to the focused GNOME Terminal tab."];
  }

  FocusTerminal(service, screen) {
    if (!validService(service) || !validScreen(screen)) {
      return [false, "This session does not have a valid GNOME Terminal target."];
    }
    const key = this._key(service, screen);
    const target = this._targets.get(key);
    if (!target) {
      return [
        false,
        "Automatic linking was missed. Focus this tab once, then use Repair terminal jump in Switchboard.",
      ];
    }
    if (!this._screenExists(service, screen)) {
      this._targets.delete(key);
      this._saveTargets();
      return [false, "That GNOME Terminal screen has closed."];
    }

    const window = this._findWindow(target.service, target.windowPath);
    if (!window) {
      this._targets.delete(key);
      this._saveTargets();
      return [false, "The linked GNOME Terminal window moved or closed; link the tab again."];
    }

    const activeTab = this._readActiveTab(target.service, target.windowPath);
    if (!activeTab) return [false, "GNOME Terminal did not expose its active tab."];
    if (activeTab.index !== target.tabIndex) {
      if (!activeTab.enabled) {
        return [false, "The linked GNOME Terminal tab layout changed; link the tab again."];
      }
      try {
        Gio.DBus.session.call_sync(
          target.service,
          target.windowPath,
          "org.gtk.Actions",
          "SetState",
          new GLib.Variant("(sva{sv})", ["active-tab", new GLib.Variant("i", target.tabIndex), {}]),
          null,
          Gio.DBusCallFlags.NONE,
          800,
          null,
        );
      } catch (error) {
        return [false, `Could not select the linked terminal tab: ${error.message}`];
      }
    }

    Main.activateWindow(window, global.get_current_time());
    return [true, "Focused the linked GNOME Terminal tab."];
  }

  FocusApplicationWindow(pid, application) {
    if (!Number.isInteger(pid) || pid <= 1 || application !== "vscode") {
      return [false, "This application session does not expose a valid window target."];
    }
    const window = this._findApplicationWindow(pid, application);
    if (!window) return [false, "That VS Code window is no longer running."];
    Main.activateWindow(window, global.get_current_time());
    return [true, "Focused the existing VS Code window."];
  }

  RaiseSwitchboard() {
    const window = this._findSwitchboardWindow();
    if (!window) return [false, "The Agent Switchboard window is not running."];

    this._keepSwitchboardAbove(window);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
      const current = this._findSwitchboardWindow();
      if (current) this._keepSwitchboardAbove(current);
      return GLib.SOURCE_REMOVE;
    });
    return [true, "Kept Agent Switchboard above other windows."];
  }

  _key(service, screen) {
    return `${service}\u0000${screen}`;
  }

  _focusedWindow() {
    return global.display.focus_window || global.display.get_focus_window?.() || null;
  }

  _terminalIdentity(window) {
    if (!window) return null;
    const service = window.get_gtk_unique_bus_name?.() || null;
    const windowPath = window.get_gtk_window_object_path?.() || null;
    if (!validService(service) || !validWindowPath(windowPath)) return null;
    const tab = this._readActiveTab(service, windowPath);
    if (!tab) return null;
    return { service, windowPath, tabIndex: tab.index };
  }

  _focusedTerminal() {
    return this._terminalIdentity(this._focusedWindow());
  }

  _rememberFocusedTerminal() {
    const terminal = this._focusedTerminal();
    if (terminal) this._lastTerminals.set(terminal.service, terminal);
  }

  _findWindow(service, windowPath) {
    for (const actor of global.get_window_actors()) {
      const window = actor.meta_window;
      if (
        window.get_gtk_unique_bus_name?.() === service &&
        window.get_gtk_window_object_path?.() === windowPath
      ) {
        return window;
      }
    }
    return null;
  }

  _findSwitchboardWindow() {
    for (const actor of global.get_window_actors()) {
      const window = actor.meta_window;
      if (window.get_title?.() === "Agent Switchboard") return window;
    }
    return null;
  }

  _findApplicationWindow(pid, application) {
    const candidates = [];
    for (const actor of global.get_window_actors()) {
      const window = actor.meta_window;
      const windowClass = [window.get_wm_class?.(), window.get_wm_class_instance?.()]
        .filter(Boolean)
        .join(" ");
      const title = window.get_title?.() || "";
      if (
        application === "vscode" &&
        (/(?:^|\s)code(?:\s|$)/i.test(windowClass) || /Visual Studio Code$/i.test(title))
      ) {
        if (window.get_pid?.() === pid) return window;
        candidates.push(window);
      }
    }
    // The session PID belongs to VS Code's extension host, not its renderer.
    // A sole editor window is therefore unambiguous and can be raised without
    // waiting for the comparatively slow `code --status` diagnostic command.
    return candidates.length === 1 ? candidates[0] : null;
  }

  _keepSwitchboardAbove(window) {
    try {
      window.unminimize();
    } catch {
      // The window may already be restored.
    }
    try {
      window.stick();
      window.make_above();
      window.raise();
    } catch (error) {
      logError(error, "Agent Switchboard could not be raised");
    }
  }

  _screenExists(service, screen) {
    try {
      Gio.DBus.session.call_sync(
        service,
        screen,
        "org.freedesktop.DBus.Peer",
        "Ping",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        600,
        null,
      );
      return true;
    } catch {
      return false;
    }
  }

  _readActiveTab(service, windowPath) {
    try {
      const result = Gio.DBus.session.call_sync(
        service,
        windowPath,
        "org.gtk.Actions",
        "Describe",
        new GLib.Variant("(s)", ["active-tab"]),
        null,
        Gio.DBusCallFlags.NONE,
        600,
        null,
      );
      const [description] = result.deep_unpack();
      const [enabled, _parameterType, state] = description;
      const index = state.length ? state[0].deep_unpack() : 0;
      return Number.isInteger(index) && index >= 0 ? { enabled, index } : null;
    } catch {
      return null;
    }
  }

  _loadTargets() {
    try {
      const [ok, contents] = GLib.file_get_contents(this._statePath);
      if (!ok) return;
      const rows = JSON.parse(ByteArray.toString(contents));
      if (!Array.isArray(rows)) return;
      for (const target of rows) {
        if (
          validService(target?.service) &&
          validScreen(target?.screen) &&
          validWindowPath(target?.windowPath) &&
          Number.isInteger(target?.tabIndex) &&
          target.tabIndex >= 0
        ) {
          this._targets.set(this._key(target.service, target.screen), target);
        }
      }
    } catch {
      this._targets.clear();
    }
  }

  _saveTargets() {
    try {
      GLib.mkdir_with_parents(this._stateDirectory, 0o700);
      GLib.file_set_contents(this._statePath, JSON.stringify([...this._targets.values()]));
      GLib.chmod(this._statePath, 0o600);
    } catch (error) {
      logError(error, "Agent Switchboard could not save GNOME Terminal links");
    }
  }
}

function init() {
  return new SwitchboardBridge();
}
