import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  installHarnessHooks,
  resolveSetupPaths,
  uninstallHarnessHooks,
} from "../scripts/harness-hooks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(temporary) {
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT;
  return {
    ...inherited,
    HOME: temporary,
    XDG_CONFIG_HOME: path.join(temporary, "config"),
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    SWITCHBOARD_HOME: path.join(temporary, "state", "agent-switchboard"),
    SWITCHBOARD_PORT: "43991",
  };
}

function writeJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(target) {
  return JSON.parse(readFileSync(target, "utf8"));
}

function runNode(args, env) {
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
    if (result.error?.code !== "EPERM") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function managedEntries(config) {
  return Object.values(config.hooks || {})
    .flat()
    .filter((group) => JSON.stringify(group).includes("switchboardctl.js"));
}

const customHook = {
  matcher: "custom",
  hooks: [{ type: "command", command: "run-my-existing-hook", timeout: 5 }],
};

test("setup merges hooks idempotently and uninstall preserves existing configuration", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-setup-hooks-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    writeJson(paths.codexHooks, {
      existing: true,
      hooks: { SessionStart: [customHook] },
    });
    writeJson(paths.claudeSettings, {
      theme: "dark",
      hooks: { Stop: [customHook] },
    });

    const first = installHarnessHooks({ root: ROOT, env });
    assert.deepEqual(first.integrations.map((item) => item.changed), [true, true]);
    const codex = readJson(paths.codexHooks);
    const claude = readJson(paths.claudeSettings);
    assert.equal(codex.existing, true);
    assert.equal(claude.theme, "dark");
    assert.deepEqual(codex.hooks.SessionStart[0], customHook);
    assert.deepEqual(claude.hooks.Stop[0], customHook);
    assert.equal(managedEntries(codex).length, 7);
    assert.equal(managedEntries(claude).length, 13);
    assert.match(managedEntries(codex)[0].hooks[0].command, /src\/bin\/switchboardctl\.js' emit --harness codex$/);
    assert.equal(existsSync(path.join(paths.stateHome, "install-backups", "codex.before-switchboard.json")), true);
    assert.equal(existsSync(path.join(paths.stateHome, "install-backups", "claude.before-switchboard.json")), true);

    const beforeSecondRun = {
      codex: readFileSync(paths.codexHooks, "utf8"),
      claude: readFileSync(paths.claudeSettings, "utf8"),
    };
    const second = installHarnessHooks({ root: ROOT, env });
    assert.deepEqual(second.integrations.map((item) => item.changed), [false, false]);
    assert.equal(readFileSync(paths.codexHooks, "utf8"), beforeSecondRun.codex);
    assert.equal(readFileSync(paths.claudeSettings, "utf8"), beforeSecondRun.claude);

    const removed = uninstallHarnessHooks({ env });
    assert.equal(removed.complete, true);
    assert.equal(readJson(paths.codexHooks).existing, true);
    assert.deepEqual(readJson(paths.codexHooks).hooks.SessionStart, [customHook]);
    assert.equal(readJson(paths.claudeSettings).theme, "dark");
    assert.deepEqual(readJson(paths.claudeSettings).hooks.Stop, [customHook]);
    assert.equal(existsSync(removed.manifestPath), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("uninstall removes generated hook files but preserves a subsequently edited entry", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-uninstall-hooks-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    installHarnessHooks({ root: ROOT, env });
    const codex = readJson(paths.codexHooks);
    codex.hooks.SessionStart[0].hooks[0].timeout = 9;
    writeJson(paths.codexHooks, codex);

    const result = uninstallHarnessHooks({ env });
    assert.equal(result.complete, false);
    assert.equal(existsSync(paths.claudeSettings), false);
    assert.equal(existsSync(paths.codexHooks), true);
    const remaining = readJson(paths.codexHooks);
    assert.equal(managedEntries(remaining).length, 1);
    assert.equal(remaining.hooks.SessionStart[0].hooks[0].timeout, 9);
    assert.equal(existsSync(result.manifestPath), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup replaces its own hook commands when the Node path changes", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-upgrade-hooks-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    installHarnessHooks({ root: ROOT, env, nodePath: "/opt/switchboard/node-old" });
    installHarnessHooks({ root: ROOT, env, nodePath: "/opt/switchboard/node-new" });

    for (const target of [paths.codexHooks, paths.claudeSettings]) {
      const entries = managedEntries(readJson(target));
      assert.ok(entries.length > 0);
      assert.equal(entries.every((entry) => JSON.stringify(entry).includes("/opt/switchboard/node-new")), true);
      assert.equal(entries.some((entry) => JSON.stringify(entry).includes("/opt/switchboard/node-old")), false);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("uninstall rejects a manifest that redirects a managed hook to another file", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-unsafe-manifest-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    const installed = installHarnessHooks({ root: ROOT, env });
    const beforeCodex = readFileSync(paths.codexHooks, "utf8");
    const unrelated = path.join(temporary, "unrelated.json");
    writeFileSync(unrelated, beforeCodex, { mode: 0o600 });
    const manifest = readJson(installed.manifestPath);
    manifest.hooks.codex.path = unrelated;
    writeJson(installed.manifestPath, manifest);

    assert.throws(() => uninstallHarnessHooks({ env }), /unsafe or unsupported codex record/);
    assert.equal(readFileSync(paths.codexHooks, "utf8"), beforeCodex);
    assert.equal(readFileSync(unrelated, "utf8"), beforeCodex);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup leaves symbolic-link hook configuration untouched", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-symlink-hooks-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    const actual = path.join(temporary, "managed-dotfiles", "codex-hooks.json");
    writeJson(actual, { hooks: { SessionStart: [customHook] } });
    mkdirSync(path.dirname(paths.codexHooks), { recursive: true });
    symlinkSync(actual, paths.codexHooks);
    const before = readFileSync(actual, "utf8");

    assert.throws(() => installHarnessHooks({ root: ROOT, env }), /symbolic link/);
    assert.equal(readFileSync(actual, "utf8"), before);
    assert.equal(existsSync(paths.claudeSettings), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup refuses malformed harness JSON without changing either file", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-invalid-hooks-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    mkdirSync(path.dirname(paths.codexHooks), { recursive: true });
    writeFileSync(paths.codexHooks, "{ invalid json\n", { mode: 0o600 });
    assert.throws(() => installHarnessHooks({ root: ROOT, env }), /not valid JSON/);
    assert.equal(readFileSync(paths.codexHooks, "utf8"), "{ invalid json\n");
    assert.equal(existsSync(paths.claudeSettings), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the unified setup and uninstall commands operate entirely inside an isolated home", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-setup-cli-"));
  const env = { ...isolatedEnvironment(temporary), PATH: "", DISPLAY: "", WAYLAND_DISPLAY: "" };
  const paths = resolveSetupPaths(env);
  try {
    const setupArgs = [path.join(ROOT, "scripts", "setup.js"), "--skip-gnome", "--no-launch", "--autostart"];
    const first = runNode(setupArgs, env);
    assert.equal(first.status, 0, first.stderr);
    const second = runNode(setupArgs, env);
    assert.equal(second.status, 0, second.stderr);
    for (const target of [
      paths.codexHooks,
      paths.claudeSettings,
      paths.openCodePlugin,
      paths.desktopLauncher,
      paths.autostartLauncher,
    ]) {
      assert.equal(existsSync(target), true, target);
    }

    const uninstall = runNode([path.join(ROOT, "scripts", "uninstall.js")], env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    for (const target of [
      paths.codexHooks,
      paths.claudeSettings,
      paths.openCodePlugin,
      paths.desktopLauncher,
      paths.autostartLauncher,
    ]) {
      assert.equal(existsSync(target), false, target);
    }
    assert.equal(existsSync(paths.stateHome), true, "runtime data should be preserved without --purge");

    const purge = runNode([path.join(ROOT, "scripts", "uninstall.js"), "--purge"], env);
    assert.equal(purge.status, 0, purge.stderr);
    assert.equal(existsSync(paths.stateHome), false, "--purge should remove marked Switchboard state");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup dry-run leaves every destination untouched", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-setup-dry-run-"));
  const env = { ...isolatedEnvironment(temporary), PATH: "", DISPLAY: "", WAYLAND_DISPLAY: "" };
  const paths = resolveSetupPaths(env);
  try {
    const result = runNode(
      [path.join(ROOT, "scripts", "setup.js"), "--dry-run", "--skip-gnome", "--no-launch", "--autostart"],
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Agent Switchboard setup \(dry run\)/);
    for (const target of [
      paths.codexHooks,
      paths.claudeSettings,
      paths.openCodePlugin,
      paths.desktopLauncher,
      paths.autostartLauncher,
      paths.stateHome,
    ]) {
      assert.equal(existsSync(target), false, target);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup preflight prevents partial installation when a destination is foreign", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-setup-preflight-"));
  const env = { ...isolatedEnvironment(temporary), PATH: "", DISPLAY: "", WAYLAND_DISPLAY: "" };
  const paths = resolveSetupPaths(env);
  try {
    mkdirSync(path.dirname(paths.desktopLauncher), { recursive: true });
    writeFileSync(paths.desktopLauncher, "[Desktop Entry]\nName=Someone Else\n", { mode: 0o644 });
    const result = runNode(
      [path.join(ROOT, "scripts", "setup.js"), "--skip-gnome", "--no-launch"],
      env,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /belongs to something else/);
    assert.equal(existsSync(paths.codexHooks), false);
    assert.equal(existsSync(paths.claudeSettings), false);
    assert.equal(existsSync(paths.openCodePlugin), false);
    assert.equal(readFileSync(paths.desktopLauncher, "utf8"), "[Desktop Entry]\nName=Someone Else\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("desktop installation refuses to overwrite a foreign launcher", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-switchboard-foreign-launcher-"));
  const env = isolatedEnvironment(temporary);
  const paths = resolveSetupPaths(env);
  try {
    mkdirSync(path.dirname(paths.desktopLauncher), { recursive: true });
    writeFileSync(paths.desktopLauncher, "[Desktop Entry]\nName=Someone Else\n", { mode: 0o644 });
    const result = runNode([path.join(ROOT, "scripts", "install-desktop.js")], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not owned by Agent Switchboard/);
    assert.equal(readFileSync(paths.desktopLauncher, "utf8"), "[Desktop Entry]\nName=Someone Else\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
