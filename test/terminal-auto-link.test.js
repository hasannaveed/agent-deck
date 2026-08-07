import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_KINDS } from "../src/domain.js";
import {
  gnomeTerminalTargetFrom,
  isAutoLinkHookEvent,
  shouldAutoLinkDiscoveredTerminal,
  shouldAutoLinkHookTerminal,
} from "../src/terminal-auto-link.js";

const gnomeTerminal = {
  terminalKind: "gnome-terminal",
  terminalTarget: "/org/gnome/Terminal/screen/abc_123",
  terminalInstance: ":1.42",
};

test("automatic GNOME linking only captures a freshly launched process", () => {
  const now = 10_000;
  assert.equal(
    shouldAutoLinkDiscoveredTerminal({ ...gnomeTerminal, startedAt: now - 1_000 }, now, 2_500),
    true,
  );
  assert.equal(
    shouldAutoLinkDiscoveredTerminal({ ...gnomeTerminal, startedAt: now - 5_001 }, now, 2_500),
    false,
  );
  assert.equal(
    shouldAutoLinkDiscoveredTerminal({ ...gnomeTerminal, startedAt: now - 8_000 }, now, 5_000),
    true,
  );
  assert.equal(
    shouldAutoLinkDiscoveredTerminal({ ...gnomeTerminal, startedAt: now - 11_000 }, now, 5_000),
    false,
  );
  assert.equal(
    shouldAutoLinkDiscoveredTerminal({ terminalKind: "tmux", startedAt: now - 100 }, now),
    false,
  );
});

test("tmux sessions retain their underlying GNOME terminal as an automatic route", () => {
  const hosted = {
    terminalKind: "tmux",
    terminalTarget: "%7",
    hostTerminalKind: "gnome-terminal",
    hostTerminalTarget: "/org/gnome/Terminal/screen/host_123",
    hostTerminalInstance: ":1.55",
  };
  assert.deepEqual(gnomeTerminalTargetFrom(hosted), {
    terminalKind: "gnome-terminal",
    terminalTarget: "/org/gnome/Terminal/screen/host_123",
    terminalInstance: ":1.55",
  });
  assert.equal(isAutoLinkHookEvent([{ kind: EVENT_KINDS.WORK_COMPLETED }]), false);
  assert.equal(isAutoLinkHookEvent([{ kind: EVENT_KINDS.WORK_STARTED, humanInitiated: true }]), true);
});

test("native hooks only auto-link foreground-originated lifecycle events", () => {
  assert.equal(
    shouldAutoLinkHookTerminal(gnomeTerminal, [{ kind: EVENT_KINDS.SESSION_STARTED }]),
    true,
  );
  assert.equal(
    shouldAutoLinkHookTerminal(gnomeTerminal, [
      { kind: EVENT_KINDS.WORK_STARTED, humanInitiated: true },
    ]),
    true,
  );
  assert.equal(
    shouldAutoLinkHookTerminal(gnomeTerminal, [{ kind: EVENT_KINDS.WORK_COMPLETED }]),
    false,
  );
  assert.equal(
    shouldAutoLinkHookTerminal(
      { terminalKind: "tmux" },
      [{ kind: EVENT_KINDS.SESSION_STARTED }],
    ),
    false,
  );
});
