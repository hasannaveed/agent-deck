#!/usr/bin/env node

import { spawn } from "node:child_process";
import { SwitchboardClient } from "../client.js";
import { focusSession } from "../focus.js";

const ESC = "\u001b[";
const RESET = `${ESC}0m`;
const FILTERS = [
  ["active", "Active"],
  ["needs_attention", "Needs"],
  ["unread", "Unread"],
  ["working", "Work"],
  ["open", "Open"],
  ["recent", "Recent"],
];
const STATE = {
  error: { glyph: "×", label: "Error", color: "38;2;233;105;105" },
  needs_attention: { glyph: "!", label: "Needs you", color: "38;2;235;184;93" },
  working: { glyph: "●", label: "Working", color: "38;2;104;169;255" },
  unread: { glyph: "◆", label: "Unread", color: "38;2;86;201;176" },
  idle: { glyph: "○", label: "Idle", color: "38;2;169;154;226" },
  unknown: { glyph: "○", label: "Open", color: "38;2;142;161;178" },
  recent: { glyph: "·", label: "Recent", color: "38;2;98;106;114" },
};
const HARNESS_LABELS = {
  codex: "CODEX",
  claude: "CLAUDE CODE",
  opencode: "OPENCODE",
};
const HARNESS_SHORT = {
  codex: "CX",
  claude: "CC",
  opencode: "OC",
};
const ACCENT = "38;2;112;186;122";
const SELECTED = "1;38;2;255;255;255;48;2;84;86;87";

function ansi(code, text, enabled = true) {
  return enabled ? `${ESC}${code}m${text}${RESET}` : text;
}

function stripAnsi(value) {
  return String(value).replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function characters(value) {
  return [...String(value ?? "")];
}

function visibleLength(value) {
  return characters(stripAnsi(value)).length;
}

function truncate(value, width) {
  const input = characters(value);
  if (width <= 0) return "";
  if (input.length <= width) return input.join("");
  if (width === 1) return "…";
  return `${input.slice(0, width - 1).join("")}…`;
}

function fit(value, width) {
  const output = truncate(value, width);
  return output + " ".repeat(Math.max(0, width - characters(output).length));
}

function align(left, right, width) {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function wrap(value, width) {
  if (!value || width <= 0) return [];
  const words = String(value).replaceAll(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = truncate(word, width);
    else if (characters(`${line} ${word}`).length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = truncate(word, width);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function relativeTime(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function stateDescription(session) {
  if (session.primaryState === "error") return session.errorSummary || "The session stopped with an error.";
  if (session.primaryState === "needs_attention") return session.attentionSummary || "Human input is required.";
  if (session.primaryState === "working") return "The agent is actively working.";
  if (session.primaryState === "unread") return "The latest result has not been opened.";
  if (session.primaryState === "idle") return "The session is open and waiting.";
  if (session.primaryState === "unknown") return "The session is open. Connect its harness integration for exact activity states.";
  return "The session closed recently.";
}

function filterSessions(snapshot, filter) {
  if (filter === "active") {
    return snapshot.sessions.filter((session) => session.presence === "live");
  }
  if (filter === "needs_attention" || filter === "unread") {
    return snapshot.sessions.filter((session) => session.presence === "live" && session.primaryState === filter);
  }
  return snapshot.sessions.filter((session) => session.group === filter);
}

function border(width, left, right, label = "") {
  const innerWidth = Math.max(0, width - 2);
  const prefix = label ? `─ ${truncate(label, Math.max(0, innerWidth - 3))} ` : "";
  return `${left}${prefix}${"─".repeat(Math.max(0, innerWidth - characters(prefix).length))}${right}`;
}

function tableLayout(width) {
  const roomy = width >= 58;
  const innerWidth = Math.max(1, width - 2);
  const harnessWidth = roomy ? 12 : 4;
  const stateWidth = roomy ? 11 : 5;
  const ageWidth = 4;
  return {
    innerWidth,
    harnessWidth,
    stateWidth,
    ageWidth,
    titleWidth: Math.max(1, innerWidth - harnessWidth - stateWidth - ageWidth - 5),
    roomy,
  };
}

function shortState(state) {
  return {
    error: "ERR",
    needs_attention: "NEED",
    working: "WORK",
    unread: "NEW",
    idle: "IDLE",
    unknown: "OPEN",
    recent: "OLD",
  }[state] || "OPEN";
}

function formatSessionRow(session, width, { selected = false, color = true } = {}) {
  const state = STATE[session.primaryState] || STATE.unknown;
  const layout = tableLayout(width);
  const harness = layout.roomy
    ? HARNESS_LABELS[session.harness] || session.harness.toUpperCase()
    : HARNESS_SHORT[session.harness] || session.harness.slice(0, 2).toUpperCase();
  const stateLabel = layout.roomy ? `${state.glyph} ${state.label.toUpperCase()}` : shortState(session.primaryState);
  const age = relativeTime(session.lastEventAt || session.updatedAt);
  const plain = ` ${fit(harness, layout.harnessWidth)} ${fit(session.title, layout.titleWidth)} ${fit(stateLabel, layout.stateWidth)} ${fit(age, layout.ageWidth)} `;

  if (selected) {
    if (!color) return `│${fit(plain, layout.innerWidth)}│`;
    const beforeState = ` ${fit(harness, layout.harnessWidth)} ${fit(session.title, layout.titleWidth)} `;
    const afterState = ` ${fit(age, layout.ageWidth)} `;
    return `│${ESC}${SELECTED}m${beforeState}${ESC}${state.color}m${fit(stateLabel, layout.stateWidth)}${ESC}${SELECTED}m${afterState}${RESET}│`;
  }

  const row = ` ${ansi("2", fit(harness, layout.harnessWidth), color)} ${fit(session.title, layout.titleWidth)} ${ansi(state.color, fit(stateLabel, layout.stateWidth), color)} ${ansi("2", fit(age, layout.ageWidth), color)} `;
  return `│${row}│`;
}

function tableHeader(width, color = true) {
  const layout = tableLayout(width);
  const harness = fit(layout.roomy ? "HARNESS" : "AGNT", layout.harnessWidth);
  const state = fit("STATE", layout.stateWidth);
  const plain = ` ${harness} ${fit("SESSION", layout.titleWidth)} ${state} ${fit("AGE", layout.ageWidth)} `;
  return `│${ansi("2", fit(plain, layout.innerWidth), color)}│`;
}

function sessionTableLines(sessions, width, height, { selectedId = null, color = true } = {}) {
  if (height <= 0) return [];
  if (height < 5) return sessions.slice(0, height).map((session) => truncate(session.title, width));
  if (!sessions.length) {
    const lines = [
      border(width, "┌", "┐", "SESSIONS"),
      `│${fit("  No sessions in this view.", Math.max(1, width - 2))}│`,
      border(width, "└", "┘"),
    ];
    return lines.slice(0, height);
  }

  const capacity = Math.max(1, Math.floor((height - 3) / 2));
  const selectedIndex = Math.max(0, sessions.findIndex((session) => session.id === selectedId));
  let start = Math.max(0, selectedIndex - Math.floor(capacity / 2));
  start = Math.min(start, Math.max(0, sessions.length - capacity));
  const visible = sessions.slice(start, start + capacity);
  const label = sessions.length > visible.length ? `SESSIONS · ${start + 1}–${start + visible.length} OF ${sessions.length}` : `SESSIONS · ${sessions.length}`;
  const lines = [border(width, "┌", "┐", label), tableHeader(width, color), border(width, "├", "┤")];

  visible.forEach((session, index) => {
    lines.push(formatSessionRow(session, width, { selected: session.id === selectedId, color }));
    if (index < visible.length - 1) lines.push(border(width, "├", "┤"));
  });
  lines.push(border(width, "└", "┘"));
  return lines.slice(0, height);
}

function printOnce(snapshot, color) {
  const width = Math.max(30, process.stdout.columns || 96);
  const counts = snapshot.counts;
  const summary = `${counts.needsYou} need you · ${counts.unread} unread · ${counts.working} working · ${counts.open} open`;
  const heading = width >= 64
    ? align(ansi("1", "Switchboard", color), ansi("2", summary, color), width)
    : `${ansi("1", "Switchboard", color)}\n${ansi("2", truncate(summary, width), color)}`;
  process.stdout.write(
    `${ansi(ACCENT, "━".repeat(width), color)}\n${heading}\n`,
  );
  if (!snapshot.sessions.length) {
    process.stdout.write("No active or recent sessions.\n");
    return;
  }
  process.stdout.write(`${sessionTableLines(snapshot.sessions, width, snapshot.sessions.length * 2 + 3, { color }).join("\n")}\n`);
}

class TerminalApp {
  constructor(client) {
    this.client = client;
    this.snapshot = { counts: {}, sessions: [] };
    this.filter = "active";
    this.selectedId = null;
    this.detail = null;
    this.message = "Connecting…";
    this.online = false;
    this.refreshing = false;
    this.focusInFlight = false;
    this.suspended = false;
    this.pollTimer = null;
    this.exitCode = 0;
    this.handleInput = this.handleInput.bind(this);
    this.render = this.render.bind(this);
  }

  sessions() {
    return filterSessions(this.snapshot, this.filter);
  }

  selectedIndex() {
    return Math.max(0, this.sessions().findIndex((session) => session.id === this.selectedId));
  }

  ensureSelection() {
    const sessions = this.sessions();
    if (!sessions.some((session) => session.id === this.selectedId)) {
      this.selectedId = sessions[0]?.id || null;
      this.detail = null;
    }
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.snapshot = await this.client.sessions();
      this.online = true;
      this.message = "Live";
      this.ensureSelection();
      if (this.detail && this.selectedId) this.detail = await this.client.session(this.selectedId);
    } catch (error) {
      this.online = false;
      this.message = `Offline: ${error.message}`;
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  move(amount) {
    const sessions = this.sessions();
    if (!sessions.length) return;
    const index = this.selectedIndex();
    this.selectedId = sessions[Math.max(0, Math.min(sessions.length - 1, index + amount))].id;
    this.render();
  }

  async inspectSelected() {
    if (!this.selectedId) return;
    try {
      this.detail = await this.client.session(this.selectedId);
      this.message = "Details";
    } catch (error) {
      this.message = error.message;
    }
    this.render();
  }

  async focusSelected() {
    if (!this.selectedId || this.focusInFlight) return;
    const selected = this.sessions().find((session) => session.id === this.selectedId);
    if (selected && !selected.focusable) {
      await this.inspectSelected();
      this.message = selected.presence === "closed" ? "Session closed · details only" : "Jump unavailable · details only";
      this.render();
      return;
    }
    this.focusInFlight = true;
    this.message = "Opening session…";
    this.render();
    try {
      const detail = await this.client.session(this.selectedId);
      const result = await focusSession(detail.session, {
        reuseCurrentTmux: true,
        focusAttachedTmux: true,
        attachCurrentTmux:
          !process.env.TMUX && detail.session.terminalKind === "tmux"
            ? (file, args) => this.attachTmuxInPlace(file, args)
            : null,
      });
      this.message = result.message;
      if (result.ok) {
        if (detail.session.unread) await this.client.action(this.selectedId, "seen");
        this.snapshot = await this.client.sessions();
        this.ensureSelection();
        this.detail = null;
      } else {
        this.detail = detail;
      }
    } catch (error) {
      this.message = error.message;
    } finally {
      this.focusInFlight = false;
    }
    this.render();
  }

  pauseTerminalUi() {
    this.suspended = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    process.stdin.off("data", this.handleInput);
    process.stdout.off("resize", this.render);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  }

  resumeTerminalUi() {
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.handleInput);
    process.stdout.on("resize", this.render);
    this.suspended = false;
    this.startPolling();
  }

  async attachTmuxInPlace(file, args) {
    this.pauseTerminalUi();
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`tmux attach exited with ${signal || `status ${code}`}`));
        });
      });
    } finally {
      this.resumeTerminalUi();
    }
  }

  async toggleUnread() {
    if (!this.selectedId) return;
    const session = this.sessions().find((item) => item.id === this.selectedId) || this.detail?.session;
    try {
      await this.client.action(this.selectedId, session?.unread ? "seen" : "unread");
      this.message = session?.unread ? "Marked seen" : "Marked unread";
      await this.refresh();
    } catch (error) {
      this.message = error.message;
      this.render();
    }
  }

  async dismiss() {
    const session = this.sessions().find((item) => item.id === this.selectedId) || this.detail?.session;
    if (!session || session.presence !== "closed") {
      this.message = "Only closed sessions can be dismissed";
      this.render();
      return;
    }
    try {
      await this.client.action(session.id, "dismiss");
      this.message = "Session dismissed";
      this.detail = null;
      await this.refresh();
    } catch (error) {
      this.message = error.message;
      this.render();
    }
  }

  setFilter(index) {
    this.filter = FILTERS[index][0];
    this.detail = null;
    this.ensureSelection();
    this.render();
  }

  handleInput(chunk) {
    const input = chunk.toString("utf8");
    if (input === "\u0003" || input === "q") return this.stop();
    if (input === "j" || input.includes("\u001b[B")) return this.move(1);
    if (input === "k" || input.includes("\u001b[A")) return this.move(-1);
    if (input === "\r" || input === "\n") return void this.focusSelected();
    if (input === "i") return void this.inspectSelected();
    if (input === "m") return void this.toggleUnread();
    if (input === "d") return void this.dismiss();
    if (input === "r") return void this.refresh();
    if (/^[1-6]$/.test(input)) return this.setFilter(Number(input) - 1);
    if (input === "\u001b" && this.detail) {
      this.detail = null;
      this.message = "Live";
      this.render();
    }
  }

  filterLine(width) {
    const tabs = FILTERS.map(([id, label]) => {
      const countValue =
        id === "active"
          ? this.snapshot.counts.open
          : id === "needs_attention"
            ? this.snapshot.counts.needsYou
            : id === "unread"
              ? this.snapshot.counts.unread
              : 0;
      const count = countValue ? ` ${countValue}` : "";
      const copy = `${label.toUpperCase()}${count}`;
      return id === this.filter ? ansi(`1;4;${ACCENT}`, copy) : ansi("2", copy);
    });
    if (width < 54) {
      const activeIndex = FILTERS.findIndex(([id]) => id === this.filter);
      return `${ansi("2", "VIEW ")}${tabs[activeIndex]}${ansi("2", "  ·  keys 1–6")}`;
    }
    return tabs.join(ansi("2", "  │  "));
  }

  listLines(width, height) {
    const sessions = this.sessions();
    return sessionTableLines(sessions, width, height, { selectedId: this.selectedId });
  }

  detailLines(width, height) {
    if (!this.detail) return [];
    const session = this.detail.session;
    const state = STATE[session.primaryState] || STATE.unknown;
    const harness = HARNESS_LABELS[session.harness] || session.harness.toUpperCase();
    const innerWidth = Math.max(1, width - 2);
    const contentWidth = Math.max(1, innerWidth - 4);
    const content = (value = "", code = null) => {
      const plain = fit(`  ${value}`, innerWidth);
      return `│${code ? ansi(code, plain) : plain}│`;
    };
    const lines = [
      border(width, "┌", "┐", "SESSION"),
      content(`${harness}   ${state.glyph} ${state.label.toUpperCase()}   ${relativeTime(session.lastEventAt)}`, state.color),
      content(),
      ...wrap(session.title, contentWidth).map((line) => content(line, "1")),
      content(),
      ...wrap(stateDescription(session), contentWidth).map((line) => content(line)),
      content(),
    ];

    const fields = [
      ["Project", session.project],
      ["Branch", session.branch],
      ["Terminal", session.terminal],
      ["Jump", session.focusable ? session.focusProvider : "Unavailable"],
      ["Location", session.cwd],
      ["Telemetry", `${session.telemetry} · ${Math.round(session.confidence * 100)}%`],
    ];
    for (const [label, value] of fields) {
      if (!value || lines.length >= height - 3) continue;
      const labelWidth = 11;
      const field = `${fit(label.toUpperCase(), labelWidth)}${truncate(value, Math.max(1, contentWidth - labelWidth))}`;
      lines.push(content(field));
    }

    if (this.detail.events.length && lines.length < height - 4) {
      lines.push(content(), content("RECENT ACTIVITY", "2"));
    }
    for (const event of this.detail.events.slice(0, 6)) {
      if (lines.length >= height - 2) break;
      lines.push(content(`· ${event.nativeType.replaceAll("_", " ")}  ${relativeTime(event.occurredAt)}`));
    }
    if (height === 1) return lines.slice(0, 1);
    return [...lines.slice(0, Math.max(0, height - 1)), border(width, "└", "┘")].slice(0, height);
  }

  render() {
    if (this.suspended) return;
    const columns = Math.max(30, process.stdout.columns || 100);
    const rows = Math.max(12, process.stdout.rows || 30);
    const counts = this.snapshot.counts || {};
    const connection = this.online ? ansi("38;2;111;186;163", "● live") : ansi("38;2;218;119;114", "× offline");
    const summary = columns >= 72
      ? `${counts.needsYou || 0} need you · ${counts.unread || 0} unread · ${counts.working || 0} working · ${counts.open || 0} open  `
      : "";
    const output = [ansi(ACCENT, "━".repeat(columns)), align(ansi("1", "SWITCHBOARD"), `${ansi("2", summary)}${connection}`, columns)];
    output.push(this.detail ? `${ansi(`1;4;${ACCENT}`, "SESSION")}  ${ansi("2", "Esc returns to the queue")}` : this.filterLine(columns));

    const bodyHeight = Math.max(1, rows - 4);
    output.push(...(this.detail ? this.detailLines(columns, bodyHeight) : this.listLines(columns, bodyHeight)));
    while (output.length < rows - 1) output.push("");

    const help = this.detail
      ? `Enter jump · Esc back · m read state · d dismiss · q quit${this.message === "Live" ? "" : `  —  ${this.message}`}`
      : `j/k move · Enter jump · i inspect · 1–6 view · q quit${this.message === "Live" ? "" : `  —  ${this.message}`}`;
    output.push(ansi("2;48;2;18;19;20", fit(` ${help}`, columns)));
    process.stdout.write(`${ESC}H${output.slice(0, rows).join("\n")}${ESC}J`);
  }

  async start() {
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.handleInput);
    process.stdout.on("resize", this.render);
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
    await this.refresh();
    this.startPolling();
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), 1200);
    this.pollTimer.unref?.();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    process.stdin.off("data", this.handleInput);
    process.stdout.off("resize", this.render);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    process.exit(this.exitCode);
  }
}

async function main() {
  const client = new SwitchboardClient();
  if (process.argv.includes("--once") || !process.stdin.isTTY || !process.stdout.isTTY) {
    const snapshot = await client.sessions();
    const visibleSnapshot = process.argv.includes("--all")
      ? snapshot
      : { ...snapshot, sessions: filterSessions(snapshot, "active") };
    printOnce(visibleSnapshot, Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
    return;
  }
  await new TerminalApp(client).start();
}

main().catch((error) => {
  process.stderr.write(`Switchboard: ${error.message}\n`);
  process.exitCode = 1;
});
