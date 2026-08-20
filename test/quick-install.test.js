import assert from "node:assert/strict";
import test from "node:test";
import {
  createQuickInstallPlan,
  parseQuickInstallArgs,
  runtimeSupported,
} from "../scripts/quick-install.js";

test("the quick installer defaults to a complete autostart installation", () => {
  const options = parseQuickInstallArgs([]);
  const plan = createQuickInstallPlan(options);

  assert.equal(options.autostart, true);
  assert.equal(options.dryRun, false);
  assert.equal(plan.installDependencies, true);
  assert.deepEqual(plan.dependencyArgs, ["ci", "--no-audit", "--no-fund"]);
  assert.deepEqual(plan.setupArgs, ["--autostart"]);
});

test("the quick installer maps user-facing options to the existing safe setup flow", () => {
  const options = parseQuickInstallArgs([
    "--no-autostart",
    "--no-launch",
    "--skip-dependencies",
    "--skip-gnome",
    "--skip-hooks",
  ]);
  const plan = createQuickInstallPlan(options);

  assert.equal(options.autostart, false);
  assert.equal(plan.installDependencies, false);
  assert.deepEqual(plan.setupArgs, ["--no-launch", "--skip-gnome", "--skip-hooks"]);
});

test("a quick-install dry run does not install dependencies or change setup destinations", () => {
  const options = parseQuickInstallArgs(["--dry-run"]);
  const plan = createQuickInstallPlan(options);

  assert.equal(plan.installDependencies, false);
  assert.deepEqual(plan.setupArgs, ["--autostart", "--dry-run"]);
});

test("the quick installer rejects ambiguous or unknown options", () => {
  assert.throws(
    () => parseQuickInstallArgs(["--autostart", "--no-autostart"]),
    /Choose either --autostart or --no-autostart/,
  );
  assert.throws(() => parseQuickInstallArgs(["--force"]), /Unknown option: --force/);
});

test("the quick installer enforces the project's minimum Node.js version", () => {
  assert.equal(runtimeSupported("22.5.0"), true);
  assert.equal(runtimeSupported("22.4.9"), false);
  assert.equal(runtimeSupported("23.0.0"), true);
  assert.equal(runtimeSupported("invalid"), false);
});
