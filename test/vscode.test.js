import assert from "node:assert/strict";
import test from "node:test";
import {
  isVisualStudioCodeCodexProcess,
  parseVisualStudioCodeStatus,
  visualStudioCodeHostFrom,
} from "../src/vscode.js";

function vscodeCodexProcess(overrides = {}) {
  return {
    pid: 8184,
    parentPid: 7846,
    harness: "codex",
    comm: "codex",
    argv: [
      "/home/example/.vscode/extensions/openai.chatgpt-26.715.61943-linux-x64/bin/linux-x86_64/codex",
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
    ],
    ...overrides,
  };
}

test("VS Code Codex extension processes are identified through their extension host", () => {
  const codex = vscodeCodexProcess();
  const processes = new Map([
    [
      7846,
      {
        pid: 7846,
        parentPid: 7440,
        comm: "code",
        argv: [
          "/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService --inspect-port=0",
        ],
      },
    ],
  ]);

  assert.equal(isVisualStudioCodeCodexProcess(codex), true);
  assert.deepEqual(visualStudioCodeHostFrom(codex, (pid) => processes.get(pid)), {
    application: "vscode",
    label: "VS Code",
    pid: 7846,
  });
  assert.equal(
    isVisualStudioCodeCodexProcess(
      vscodeCodexProcess({ argv: ["/usr/bin/codex", "app-server", "features.code_mode_host=true"] }),
    ),
    false,
  );
  assert.equal(isVisualStudioCodeCodexProcess(vscodeCodexProcess({ argv: [codex.argv[0]] })), false);
});

test("VS Code status maps an extension host to its exact editor window", () => {
  const status = `
CPU % Mem MB PID Process
    0  120 7440 code
    1  400 7549   window [1] (Git Graph - aim-project - Visual Studio Code)
    0  200 7846 extension-host [1]
    0  300 9000   window [2] (Other - Visual Studio Code)
    0  200 9100 extension-host [2]
`;

  assert.deepEqual(parseVisualStudioCodeStatus(status, 7846), {
    windowIndex: 1,
    pid: 7549,
    title: "Git Graph - aim-project - Visual Studio Code",
  });
  assert.equal(parseVisualStudioCodeStatus(status, 9999), null);
  assert.equal(parseVisualStudioCodeStatus(status, "$(touch nope)"), null);
});
