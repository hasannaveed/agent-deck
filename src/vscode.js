import path from "node:path";

const VSCODE_CODEX_EXTENSION =
  /(?:^|[/\\])\.vscode(?:-insiders)?[/\\]extensions[/\\]openai\.chatgpt-[^/\\]+(?:[/\\]|$)/i;
const VSCODE_COMMANDS = new Set(["code", "code-insiders"]);

function commandName(processInfo) {
  const executable = String(processInfo?.argv?.[0] || processInfo?.comm || "").split(/\s+/, 1)[0];
  return path.basename(String(executable)).toLowerCase();
}

export function isVisualStudioCodeCodexProcess(processInfo) {
  if (processInfo?.harness !== "codex") return false;
  const argv = Array.isArray(processInfo.argv) ? processInfo.argv : [];
  const executable = String(argv[0] || "");
  return (
    VSCODE_CODEX_EXTENSION.test(executable) &&
    argv.includes("app-server") &&
    argv.some((argument) => String(argument).includes("features.code_mode_host=true"))
  );
}

function isVisualStudioCodeExtensionHost(processInfo) {
  if (!VSCODE_COMMANDS.has(commandName(processInfo))) return false;
  const argv = Array.isArray(processInfo?.argv) ? processInfo.argv : [];
  const commandLine = argv.join(" ");
  return (
    /(?:^|\s)--type=utility(?:\s|$)/.test(commandLine) &&
    /(?:^|\s)--utility-sub-type=[^\s]+/.test(commandLine)
  );
}

export function visualStudioCodeHostFrom(processInfo, readProcess) {
  if (!isVisualStudioCodeCodexProcess(processInfo)) return null;

  let pid = Number(processInfo.parentPid);
  const visited = new Set([Number(processInfo.pid)]);
  for (let depth = 0; depth < 4 && Number.isInteger(pid) && pid > 1 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const ancestor = typeof readProcess === "function" ? readProcess(pid) : null;
    if (!ancestor) break;
    if (isVisualStudioCodeExtensionHost(ancestor)) {
      return {
        application: "vscode",
        label: "VS Code",
        pid: ancestor.pid,
      };
    }
    pid = Number(ancestor.parentPid);
  }

  // The extension executable is already definitive. Keeping the host label
  // still enables a safe workspace fallback when the parent exits mid-scan.
  return { application: "vscode", label: "VS Code", pid: null };
}

export function parseVisualStudioCodeStatus(output, extensionHostPid) {
  const expectedPid = Number(extensionHostPid);
  if (!Number.isInteger(expectedPid) || expectedPid <= 1) return null;

  let windowIndex = null;
  const windows = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const row = line.match(/^\s*\S+\s+\S+\s+(\d+)\s+(.+?)\s*$/);
    if (!row) continue;
    const pid = Number(row[1]);
    const description = row[2].trim();
    const extensionHost = description.match(/^extension-host\s+\[(\d+)](?:\s|$)/i);
    if (pid === expectedPid && extensionHost) windowIndex = Number(extensionHost[1]);

    const window = description.match(/^window\s+\[(\d+)]\s+\((.*)\)$/i);
    if (window) {
      windows.set(Number(window[1]), {
        pid,
        title: window[2].trim().slice(0, 240) || null,
      });
    }
  }

  if (!Number.isInteger(windowIndex)) return null;
  const target = windows.get(windowIndex);
  return target ? { windowIndex, ...target } : null;
}
