import assert from "node:assert/strict";
import test from "node:test";
import {
  newestAttachedTmuxClientTerminal,
  parseTmuxClients,
  terminalTargetForTmuxClient,
  TMUX_CLIENT_FORMAT,
} from "../src/tmux-clients.js";

test("tmux clients are validated and ordered by recent activity", () => {
  assert.deepEqual(
    parseTmuxClients(
      "41\t1700000000\t/dev/pts/4\n42\t1700000100\t/dev/pts/5\nbad\t1700000200\tignored\n",
    ),
    [
      { pid: 42, activity: 1700000100, name: "/dev/pts/5" },
      { pid: 41, activity: 1700000000, name: "/dev/pts/4" },
    ],
  );
});

test("tmux client PIDs resolve to exact supported terminal targets", () => {
  const target = terminalTargetForTmuxClient(42, () => ({
    terminalKind: "gnome-terminal",
    terminalTarget: "/org/gnome/Terminal/screen/abc_123",
    terminalInstance: ":1.42",
  }));
  assert.deepEqual(target, {
    terminalKind: "gnome-terminal",
    terminalTarget: "/org/gnome/Terminal/screen/abc_123",
    terminalInstance: ":1.42",
  });
  assert.equal(terminalTargetForTmuxClient(42, () => ({ terminalKind: "unknown" })), null);
});

test("the most recent attached tmux client is resolved without a shell", () => {
  const calls = [];
  const terminal = newestAttachedTmuxClientTerminal(
    {
      terminalKind: "tmux",
      terminalTarget: "%7",
      terminalInstance: "/tmp/tmux-1000/default",
    },
    {
      execute: (file, args, options) => {
        calls.push([file, args, options]);
        return "41\t1700000000\t/dev/pts/4\n42\t1700000100\t/dev/pts/5\n";
      },
      resolve: (pid) =>
        pid === 42
          ? {
              terminalKind: "gnome-terminal",
              terminalTarget: "/org/gnome/Terminal/screen/abc_123",
              terminalInstance: ":1.42",
            }
          : null,
    },
  );

  assert.equal(terminal.client.pid, 42);
  assert.deepEqual(calls[0][1], [
    "-S",
    "/tmp/tmux-1000/default",
    "list-clients",
    "-t",
    "%7",
    "-F",
    TMUX_CLIENT_FORMAT,
  ]);
});
