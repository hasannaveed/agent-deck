import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SETUP_MANIFEST_VERSION = 1;
export const SETUP_MANIFEST_NAME = "setup-manifest.json";

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeTextAtomic(target, content, mode = 0o600) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJson(target, label) {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON; it was left unchanged: ${error.message}`);
  }
}

function assertRegularFile(target, label) {
  if (!existsSync(target)) return;
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link; it was left unchanged. Merge the Switchboard hooks manually instead.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a regular file; it was left unchanged.`);
  }
}

function switchboardCommand(nodePath, controlPath, harness) {
  return `${shellQuote(nodePath)} ${shellQuote(controlPath)} emit --harness ${harness}`;
}

function switchboardHook(group, harness) {
  if (!plainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((hook) => {
    const command = typeof hook?.command === "string" ? hook.command : "";
    return (
      command.includes("switchboardctl") &&
      /(?:^|\s)emit(?:\s|$)/.test(command) &&
      new RegExp(`(?:^|\\s)--harness(?:=|\\s+)${harness}(?:\\s|$)`).test(command)
    );
  });
}

function generatedHooks(template, harness, nodePath, controlPath) {
  const hooks = clone(template.hooks);
  const command = switchboardCommand(nodePath, controlPath, harness);
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks || []) hook.command = command;
    }
  }
  return hooks;
}

function validateHookConfig(config, events, label) {
  if (!plainObject(config)) throw new Error(`${label} must contain a JSON object; it was left unchanged.`);
  if (config.hooks !== undefined && !plainObject(config.hooks)) {
    throw new Error(`${label} has a non-object hooks field; it was left unchanged.`);
  }
  for (const event of events) {
    if (config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event])) {
      throw new Error(`${label} has a non-array hooks.${event} field; it was left unchanged.`);
    }
  }
}

function removeExactEntry(groups, entry) {
  const index = groups.findIndex((candidate) => isDeepStrictEqual(candidate, entry));
  if (index < 0) return false;
  groups.splice(index, 1);
  return true;
}

function planHookConfig({
  target,
  template,
  harness,
  nodePath,
  controlPath,
  previous = null,
}) {
  const existed = existsSync(target);
  assertRegularFile(target, target);
  const original = existed ? readJson(target, target) : {};
  const config = clone(original);
  const desiredHooks = generatedHooks(template, harness, nodePath, controlPath);
  const previousEntries = Array.isArray(previous?.entries) ? previous.entries : [];
  const events = new Set([...Object.keys(desiredHooks), ...previousEntries.map((item) => item.event)]);
  validateHookConfig(config, events, target);

  const hooksPropertyExisted = plainObject(config.hooks);
  if (!config.hooks) config.hooks = {};
  const retainedPrevious = new Set();
  const entries = [];

  for (const [event, desiredGroups] of Object.entries(desiredHooks)) {
    const groups = config.hooks[event] || [];
    if (!config.hooks[event]) config.hooks[event] = groups;

    for (const desired of desiredGroups) {
      const previousIndex = previousEntries.findIndex(
        (item, index) =>
          !retainedPrevious.has(index) &&
          item.event === event &&
          isDeepStrictEqual(item.entry, desired) &&
          groups.some((candidate) => isDeepStrictEqual(candidate, item.entry)),
      );
      if (previousIndex >= 0) {
        previousEntries.forEach((item, index) => {
          if (item.event === event && isDeepStrictEqual(item.entry, desired)) retainedPrevious.add(index);
        });
        entries.push({ event, entry: clone(desired) });
        continue;
      }
      const ownedEntriesBeingReplaced = previousEntries.filter(
        (item, index) =>
          !retainedPrevious.has(index) &&
          item.event === event &&
          groups.some((candidate) => isDeepStrictEqual(candidate, item.entry)),
      );
      const hasUnmanagedSwitchboardEntry = groups.some(
        (candidate) =>
          switchboardHook(candidate, harness) &&
          !ownedEntriesBeingReplaced.some((item) => isDeepStrictEqual(candidate, item.entry)) &&
          !entries.some(
            (item) => item.event === event && isDeepStrictEqual(candidate, item.entry),
          ),
      );
      if (hasUnmanagedSwitchboardEntry) continue;
      groups.push(clone(desired));
      entries.push({ event, entry: clone(desired) });
    }
  }

  previousEntries.forEach((item, index) => {
    if (retainedPrevious.has(index)) return;
    const groups = config.hooks[item.event];
    if (!Array.isArray(groups)) return;
    removeExactEntry(groups, item.entry);
    if (groups.length === 0 && !Object.hasOwn(desiredHooks, item.event)) delete config.hooks[item.event];
  });

  if (Object.keys(config.hooks).length === 0 && !hooksPropertyExisted) delete config.hooks;
  const changed = !isDeepStrictEqual(original, config);
  return {
    target,
    original,
    config,
    changed,
    record: {
      path: target,
      fileCreated: previous?.fileCreated ?? !existed,
      hooksPropertyCreated: previous?.hooksPropertyCreated ?? !hooksPropertyExisted,
      entries,
    },
  };
}

function manifestPathFor(paths) {
  return path.join(paths.stateHome, SETUP_MANIFEST_NAME);
}

function readManifest(paths) {
  const target = manifestPathFor(paths);
  if (!existsSync(target)) return null;
  assertRegularFile(target, target);
  const manifest = readJson(target, target);
  if (manifest.version !== SETUP_MANIFEST_VERSION || !plainObject(manifest.hooks)) {
    throw new Error(`${target} has an unsupported format; no hook configuration was changed.`);
  }
  const expectedPaths = {
    codex: paths.codexHooks,
    claude: paths.claudeSettings,
  };
  for (const [harness, record] of Object.entries(manifest.hooks)) {
    const expectedPath = expectedPaths[harness];
    if (
      !expectedPath ||
      !plainObject(record) ||
      typeof record.path !== "string" ||
      path.resolve(record.path) !== expectedPath ||
      typeof record.fileCreated !== "boolean" ||
      typeof record.hooksPropertyCreated !== "boolean" ||
      !Array.isArray(record.entries) ||
      record.entries.length > 256 ||
      !record.entries.every(
        (item) =>
          plainObject(item) &&
          typeof item.event === "string" &&
          plainObject(item.entry) &&
          switchboardHook(item.entry, harness),
      )
    ) {
      throw new Error(`${target} has an unsafe or unsupported ${harness} record; no hook configuration was changed.`);
    }
  }
  return manifest;
}

function writeManifest(paths, manifest) {
  writeTextAtomic(manifestPathFor(paths), `${JSON.stringify(manifest, null, 2)}\n`);
}

function backupConfig(paths, name, plan) {
  if (!plan.changed || !existsSync(plan.target)) return null;
  const directory = path.join(paths.stateHome, "install-backups");
  const target = path.join(directory, `${name}.before-switchboard.json`);
  if (existsSync(target)) return target;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(plan.target, target);
  return target;
}

export function resolveSetupPaths(env = process.env) {
  const userHome = path.resolve(env.HOME || homedir());
  const configHome = path.resolve(env.XDG_CONFIG_HOME || path.join(userHome, ".config"));
  const dataHome = path.resolve(env.XDG_DATA_HOME || path.join(userHome, ".local", "share"));
  const stateRoot = path.resolve(env.XDG_STATE_HOME || path.join(userHome, ".local", "state"));
  const stateHome = path.resolve(env.SWITCHBOARD_HOME || path.join(stateRoot, "agent-switchboard"));
  return {
    userHome,
    configHome,
    dataHome,
    stateHome,
    codexHooks: path.join(userHome, ".codex", "hooks.json"),
    claudeSettings: path.join(userHome, ".claude", "settings.json"),
    openCodePlugin: path.join(configHome, "opencode", "plugins", "switchboard.js"),
    desktopLauncher: path.join(dataHome, "applications", "agent-switchboard.desktop"),
    autostartLauncher: path.join(configHome, "autostart", "agent-switchboard.desktop"),
    gnomeExtension: path.join(
      dataHome,
      "gnome-shell",
      "extensions",
      "agent-switchboard@skylabs-ai.com",
    ),
  };
}

export function installHarnessHooks({ root, env = process.env, nodePath = process.execPath, dryRun = false }) {
  const paths = resolveSetupPaths(env);
  const controlPath = path.join(root, "src", "bin", "switchboardctl.js");
  const manifest = readManifest(paths);
  const definitions = [
    {
      name: "codex",
      target: paths.codexHooks,
      template: readJson(path.join(root, "integrations", "codex", "hooks.json"), "Codex hook template"),
    },
    {
      name: "claude",
      target: paths.claudeSettings,
      template: readJson(path.join(root, "integrations", "claude", "settings.json"), "Claude hook template"),
    },
  ];
  const plans = definitions.map((definition) =>
    planHookConfig({
      ...definition,
      harness: definition.name,
      nodePath,
      controlPath,
      previous: manifest?.hooks?.[definition.name] || null,
    }),
  );
  const nextManifest = {
    version: SETUP_MANIFEST_VERSION,
    root,
    installedAt: Date.now(),
    hooks: Object.fromEntries(plans.map((plan, index) => [definitions[index].name, plan.record])),
  };

  if (!dryRun) {
    plans.forEach((plan, index) => backupConfig(paths, definitions[index].name, plan));
    const pendingHooks = { ...(manifest?.hooks || {}) };
    for (const [index, plan] of plans.entries()) {
      const name = definitions[index].name;
      const previousEntries = manifest?.hooks?.[name]?.entries || [];
      const entries = [...previousEntries];
      for (const item of plan.record.entries) {
        if (!entries.some((candidate) => isDeepStrictEqual(candidate, item))) entries.push(item);
      }
      pendingHooks[name] = {
        ...plan.record,
        entries,
      };
    }
    writeManifest(paths, { ...nextManifest, hooks: pendingHooks, pending: true });
    for (const plan of plans) {
      if (!plan.changed) continue;
      const mode = existsSync(plan.target) ? statSync(plan.target).mode & 0o777 : 0o600;
      writeTextAtomic(plan.target, `${JSON.stringify(plan.config, null, 2)}\n`, mode);
    }
    writeManifest(paths, nextManifest);
  }

  return {
    paths,
    manifestPath: manifestPathFor(paths),
    integrations: plans.map((plan, index) => ({
      harness: definitions[index].name,
      path: plan.target,
      changed: plan.changed,
      ownedEntries: plan.record.entries.length,
    })),
  };
}

export function uninstallHarnessHooks({ env = process.env, dryRun = false }) {
  const paths = resolveSetupPaths(env);
  const manifest = readManifest(paths);
  if (!manifest) return { paths, manifestPath: manifestPathFor(paths), integrations: [], complete: true };

  const results = [];
  const unresolvedHooks = {};
  for (const [harness, record] of Object.entries(manifest.hooks)) {
    const target = harness === "codex" ? paths.codexHooks : paths.claudeSettings;
    if (!existsSync(target)) {
      results.push({ harness, path: target, removed: 0, preserved: 0, fileRemoved: false });
      continue;
    }

    let config;
    try {
      assertRegularFile(target, target);
      config = readJson(target, target);
      validateHookConfig(config, (record.entries || []).map((item) => item.event), target);
    } catch (error) {
      results.push({ harness, path: target, removed: 0, preserved: record.entries?.length || 0, error: error.message });
      unresolvedHooks[harness] = record;
      continue;
    }

    let removed = 0;
    const unresolvedEntries = [];
    for (const item of record.entries || []) {
      const groups = config.hooks?.[item.event];
      if (Array.isArray(groups) && removeExactEntry(groups, item.entry)) {
        removed += 1;
        if (groups.length === 0) delete config.hooks[item.event];
      } else {
        unresolvedEntries.push(item);
      }
    }
    if (record.hooksPropertyCreated && plainObject(config.hooks) && Object.keys(config.hooks).length === 0) {
      delete config.hooks;
    }
    const fileRemoved = record.fileCreated && Object.keys(config).length === 0;
    if (!dryRun) {
      if (fileRemoved) unlinkSync(target);
      else if (removed > 0) {
        const mode = statSync(target).mode & 0o777;
        writeTextAtomic(target, `${JSON.stringify(config, null, 2)}\n`, mode);
      }
    }
    if (unresolvedEntries.length) unresolvedHooks[harness] = { ...record, entries: unresolvedEntries };
    results.push({
      harness,
      path: target,
      removed,
      preserved: unresolvedEntries.length,
      fileRemoved,
    });
  }

  const complete = Object.keys(unresolvedHooks).length === 0;
  if (!dryRun) {
    if (complete) {
      const target = manifestPathFor(paths);
      if (existsSync(target)) unlinkSync(target);
    } else {
      writeManifest(paths, { ...manifest, hooks: unresolvedHooks, pending: false });
    }
  }
  return { paths, manifestPath: manifestPathFor(paths), integrations: results, complete };
}
