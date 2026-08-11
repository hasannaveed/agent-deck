import { sessionNavigationCommand } from "./session-navigation.js";

const STATE_LABELS = {
  error: "Error",
  needs_attention: "Needs you",
  working: "Working",
  unread: "Unread",
  idle: "Idle",
  unknown: "Open",
  recent: "Recent",
};

const HARNESS_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

const HARNESS_MARKS = {
  codex: "CX",
  claude: "CC",
  opencode: "OC",
};

const FILTER_LABELS = {
  active: "Active sessions",
  needs_attention: "Needs your input",
  working: "Working now",
  unread: "Unread results",
  open: "Open sessions",
  recent: "Recent sessions",
};

const desktop = window.switchboardDesktop || null;

const state = {
  token: null,
  snapshot: { counts: {}, sessions: [] },
  selectedId: null,
  detail: null,
  filter: "active",
  query: "",
  connected: false,
  refreshTimer: null,
  desktopState: null,
  toolsOpen: false,
  focusInFlightId: null,
  terminalRepairId: null,
};

const elements = {
  connection: document.querySelector("#connection-state"),
  connectionCopy: document.querySelector("#connection-copy"),
  needsCount: document.querySelector("#needs-count"),
  workingCount: document.querySelector("#working-count"),
  unreadCount: document.querySelector("#unread-count"),
  liveCount: document.querySelector("#live-count"),
  openCount: document.querySelector("#open-count"),
  trafficRail: document.querySelector("#traffic-rail"),
  railWorking: document.querySelector("#rail-working"),
  railAttention: document.querySelector("#rail-attention"),
  railUnread: document.querySelector("#rail-unread"),
  railError: document.querySelector("#rail-error"),
  railOpen: document.querySelector("#rail-open"),
  filterNeedsCount: document.querySelector("#filter-needs-count"),
  queueTitle: document.querySelector("#queue-title"),
  queueCount: document.querySelector("#queue-count"),
  groups: document.querySelector("#session-groups"),
  empty: document.querySelector("#empty-state"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailContent: document.querySelector("#detail-content"),
  detailClose: document.querySelector("#detail-close"),
  search: document.querySelector("#session-search"),
  controlDeck: document.querySelector("#control-deck"),
  toolsToggle: document.querySelector("#tools-toggle"),
  toast: document.querySelector("#toast"),
  desktopTitlebar: document.querySelector("#desktop-titlebar"),
  desktopMinimize: document.querySelector("#desktop-minimize"),
  desktopHide: document.querySelector("#desktop-hide"),
  desktopDock: document.querySelector("#desktop-dock"),
  dockLiveCount: document.querySelector("#dock-live-count"),
  dockStatus: document.querySelector("#dock-status"),
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function harnessMark(session, extraClass = "") {
  const mark = node("span", `harness-mark ${extraClass}`.trim(), HARNESS_MARKS[session.harness] || "AG");
  mark.dataset.harness = session.harness;
  mark.title = HARNESS_LABELS[session.harness] || session.harness;
  return mark;
}

function statusMessage(session) {
  if (session.primaryState === "error") return session.errorSummary || "The session stopped with an error.";
  if (session.primaryState === "needs_attention") return session.attentionSummary || "Human input is required.";
  if (session.primaryState === "working") return "The agent is actively working.";
  if (session.primaryState === "unread") return "The latest result has not been opened.";
  if (session.primaryState === "idle") return "The session is open and waiting.";
  if (session.primaryState === "unknown") {
    return "The session is open. Connect its harness integration for exact activity states.";
  }
  return session.presence === "closed" ? "The session closed recently." : "Recently updated.";
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

function relativeTimeNode(className, timestamp) {
  const element = node("time", className, relativeTime(timestamp));
  if (timestamp) element.dataset.timestamp = String(timestamp);
  return element;
}

function sessionContext(session) {
  const title = session.title.toLowerCase();
  const project = session.project && !title.includes(session.project.toLowerCase()) ? session.project : null;
  return [project, session.branch].filter(Boolean).join(" · ") || session.terminal || "No location";
}

function sessionDisplayTitle(session) {
  const suffixes = [session.harness, HARNESS_LABELS[session.harness]]
    .filter(Boolean)
    .map((value) => ` · ${String(value).toLowerCase()}`);
  const title = session.title.trim();
  const lowerTitle = title.toLowerCase();
  const suffix = suffixes.find((candidate) => lowerTitle.endsWith(candidate));
  return suffix ? title.slice(0, -suffix.length) : title;
}

function filteredSessions() {
  const query = state.query.toLowerCase().trim();
  return state.snapshot.sessions.filter((session) => {
    const matchesFilter =
      state.filter === "active"
        ? session.presence === "live"
        : state.filter === "needs_attention"
          ? session.presence === "live" && session.primaryState === "needs_attention"
          : state.filter === "unread"
            ? session.presence === "live" && session.primaryState === "unread"
            : session.group === state.filter;
    const haystack = [session.title, session.project, session.cwd, session.branch, session.harness]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });
}

function buildSessionRow(session) {
  const row = node("div", `session-row state-${session.primaryState}`);
  const canJump = Boolean(desktop && session.focusable);
  row.dataset.harness = session.harness;
  row.dataset.sessionId = session.id;
  row.setAttribute("role", "listitem");
  const selected = session.id === state.selectedId;
  row.classList.toggle("is-selected", selected);
  if (selected) row.setAttribute("aria-current", "true");
  row.classList.toggle("is-jumping", session.id === state.focusInFlightId);

  const open = node("button", "session-open");
  open.type = "button";
  open.dataset.sessionId = session.id;
  open.setAttribute(
    "aria-label",
    `${canJump ? "Open" : "Inspect"} ${session.title}, ${HARNESS_LABELS[session.harness] || session.harness}, ${STATE_LABELS[session.primaryState]}`,
  );
  open.append(harnessMark(session, "row-harness-mark"));

  const copy = node("span", "session-copy");
  copy.append(node("span", "session-title", sessionDisplayTitle(session)));
  const meta = node("span", "session-meta");
  const harness = node("span", "session-harness", HARNESS_LABELS[session.harness] || session.harness);
  harness.dataset.harness = session.harness;
  meta.append(harness);
  meta.append(node("span", "session-meta-separator", "·"));
  meta.append(relativeTimeNode("session-age", session.lastEventAt || session.updatedAt));
  copy.append(meta);
  open.append(copy);
  open.append(node("span", "session-jump", canJump ? "↗" : "…"));
  open.addEventListener("click", () => openSession(session));

  const inspect = node("button", "inspect-session");
  inspect.type = "button";
  inspect.title = "Session details";
  inspect.setAttribute("aria-label", `Inspect ${session.title}`);
  inspect.append(node("span", "state-dot"));
  inspect.append(node("span", "state-name", STATE_LABELS[session.primaryState]));
  inspect.addEventListener("click", () => selectSession(session.id));

  if (session.id === state.focusInFlightId) {
    open.disabled = true;
    inspect.disabled = true;
    row.setAttribute("aria-busy", "true");
  }

  row.append(open, inspect);
  return row;
}

function renderSessions() {
  const sessions = filteredSessions();
  elements.groups.replaceChildren(...sessions.map(buildSessionRow));
  elements.empty.hidden = sessions.length > 0;
  elements.queueTitle.textContent = state.query.trim() ? "Search results" : FILTER_LABELS[state.filter];
  elements.queueCount.textContent = String(sessions.length);
  elements.toolsToggle.classList.toggle("has-filter", state.filter !== "active" || Boolean(state.query.trim()));
}

function updateSessionSelection() {
  for (const row of elements.groups.querySelectorAll(".session-row")) {
    const selected = row.dataset.sessionId === state.selectedId;
    row.classList.toggle("is-selected", selected);
    if (selected) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

function setSessionJumping(id, jumping) {
  const row = elements.groups.querySelector(`.session-row[data-session-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.classList.toggle("is-jumping", jumping);
  row.toggleAttribute("aria-busy", jumping);
  for (const button of row.querySelectorAll("button")) button.disabled = jumping;
}

function updateRelativeTimes() {
  for (const element of document.querySelectorAll("time[data-timestamp]")) {
    element.textContent = relativeTime(Number(element.dataset.timestamp));
  }
}

function detailField(label, value) {
  const wrapper = node("div");
  wrapper.append(node("dt", "", label));
  wrapper.append(node("dd", "", value || "—"));
  return wrapper;
}

function disclosure(label, count = null) {
  const wrapper = node("details", "detail-disclosure");
  const summary = node("summary");
  summary.append(node("span", "", label));
  if (count !== null) summary.append(node("span", "disclosure-count", String(count)));
  wrapper.append(summary);
  return wrapper;
}

function renderDetail() {
  const detail = state.detail;
  elements.detailEmpty.hidden = Boolean(detail);
  elements.detailContent.hidden = !detail;
  elements.detailContent.replaceChildren();
  document.body.classList.toggle("detail-open", Boolean(detail));
  if (!detail) return;

  const session = detail.session;
  const header = node("header", "detail-header");
  const source = node("div", "detail-source");
  source.append(harnessMark(session, "detail-harness-mark"));
  const sourceCopy = node("div");
  sourceCopy.append(node("span", "detail-harness-name", HARNESS_LABELS[session.harness] || session.harness));
  sourceCopy.append(node("span", "detail-context", sessionContext(session)));
  source.append(sourceCopy);
  header.append(source);
  header.append(node("h2", "", sessionDisplayTitle(session)));

  const detailStatus = node("div", "detail-status");
  const badge = node("span", "state-badge");
  badge.dataset.state = session.primaryState;
  badge.append(node("span", "state-dot"));
  badge.append(node("span", "", STATE_LABELS[session.primaryState]));
  detailStatus.append(badge);
  detailStatus.append(relativeTimeNode("detail-time", session.lastEventAt));
  header.append(detailStatus);
  header.append(node("p", "detail-message", statusMessage(session)));
  elements.detailContent.append(header);

  const actions = node("div", "detail-actions");
  if (desktop && session.focusable) {
    const openButton = node("button", "action-button action-primary", "Open session");
    openButton.type = "button";
    openButton.addEventListener("click", () => activateSession(session));
    actions.append(openButton);
  }
  if (
    desktop &&
    session.presence === "live" &&
    session.terminalKind === "gnome-terminal" &&
    state.terminalRepairId === session.id
  ) {
    const linkButton = node("button", "action-button", "Repair terminal jump");
    linkButton.type = "button";
    linkButton.title = "Focus the target GNOME Terminal tab, then click here to repair its automatic jump route";
    linkButton.addEventListener("click", () => linkTerminal(session));
    actions.append(linkButton);
  }
  const readButton = node("button", "action-button", session.unread ? "Mark seen" : "Mark unread");
  readButton.type = "button";
  readButton.addEventListener("click", () => setReadState(session));
  actions.append(readButton);
  if (session.cwd) {
    const copyButton = node("button", "action-button", "Copy location");
    copyButton.type = "button";
    copyButton.addEventListener("click", () => copyLocation(session.cwd));
    actions.append(copyButton);
  }
  if (session.presence === "closed") {
    const dismissButton = node("button", "action-button", "Dismiss");
    dismissButton.type = "button";
    dismissButton.addEventListener("click", () => runSessionAction(session.id, "dismiss", "Session dismissed"));
    actions.append(dismissButton);
  }
  elements.detailContent.append(actions);

  const metadata = disclosure("Session details");
  const grid = node("dl", "metadata-grid");
  grid.append(detailField("Harness", HARNESS_LABELS[session.harness] || session.harness));
  grid.append(detailField("Project", session.project));
  grid.append(detailField("Branch", session.branch));
  grid.append(detailField("Terminal", session.terminal));
  grid.append(detailField("Jump route", session.focusable ? session.focusProvider : "Unavailable"));
  grid.append(detailField("Process", session.pid ? `PID ${session.pid}` : null));
  grid.append(detailField("Location", session.cwd));
  grid.append(detailField("Telemetry", `${session.telemetry} · ${Math.round(session.confidence * 100)}%`));
  metadata.append(grid);
  if (session.telemetry === "process" || session.primaryState === "unknown") {
    metadata.append(
      node(
        "p",
        "telemetry-note",
        "State is inferred from local process and lifecycle signals. Native harness integration provides exact attention and completion events.",
      ),
    );
  }
  elements.detailContent.append(metadata);

  const history = disclosure("Activity", detail.events.length);
  const list = node("ol", "event-list");
  for (const event of detail.events.slice(0, 8)) {
    const item = node("li", "event-item");
    const copy = node("div");
    copy.append(node("div", "event-name", event.nativeType.replaceAll("_", " ")));
    if (event.summary) copy.append(node("div", "event-summary", event.summary));
    item.append(copy);
    item.append(relativeTimeNode("event-time", event.occurredAt));
    list.append(item);
  }
  if (!detail.events.length) list.append(node("li", "event-summary", "No activity has been recorded."));
  history.append(list);
  elements.detailContent.append(history);
}

function renderHeader() {
  const counts = state.snapshot.counts || {};
  const liveSessions = state.snapshot.sessions.filter((session) => session.presence === "live");
  const working = liveSessions.filter((session) => session.primaryState === "working").length;
  const attention = liveSessions.filter((session) => session.primaryState === "needs_attention").length;
  const unread = liveSessions.filter((session) => session.primaryState === "unread").length;
  const errors = liveSessions.filter((session) => session.primaryState === "error").length;
  const open = liveSessions.filter((session) => ["idle", "unknown"].includes(session.primaryState)).length;
  const railParts = [
    [elements.railError, errors],
    [elements.railAttention, attention],
    [elements.railUnread, unread],
    [elements.railWorking, working],
    [elements.railOpen, open],
  ];

  elements.liveCount.textContent = String(liveSessions.length).padStart(2, "0");
  elements.needsCount.textContent = String(attention);
  elements.workingCount.textContent = String(working);
  elements.unreadCount.textContent = String(unread);
  elements.openCount.textContent = String(open);
  const dockState = errors
    ? "error"
    : attention
      ? "needs_attention"
      : unread
        ? "unread"
        : working
          ? "working"
          : "idle";
  const dockStateLabel = {
    error: "error",
    needs_attention: "needs your input",
    unread: "unread result",
    working: "working",
    idle: "open",
  }[dockState];
  elements.dockLiveCount.textContent = String(liveSessions.length);
  elements.dockStatus.dataset.state = dockState;
  elements.desktopDock.setAttribute(
    "aria-label",
    `Expand Switchboard, ${liveSessions.length} live, ${dockStateLabel}`,
  );
  elements.filterNeedsCount.textContent = String(
    state.snapshot.sessions.filter((session) => session.primaryState === "needs_attention").length,
  );
  elements.trafficRail.classList.toggle("is-empty", liveSessions.length === 0);
  elements.trafficRail.setAttribute(
    "aria-label",
    liveSessions.length
      ? `${errors} errors, ${attention} need you, ${unread} unread, ${working} working, ${open} open`
      : "No live sessions",
  );
  for (const [segment, count] of railParts) {
    segment.hidden = count === 0;
    segment.style.flexGrow = String(count);
  }
  const unseen = (counts.needsYou || 0) + (counts.unread || 0) + (counts.errors || 0);
  document.title = unseen ? `(${unseen}) Switchboard` : "Switchboard";
}

function render() {
  renderHeader();
  renderSessions();
  renderDetail();
}

function setConnection(connected, copy) {
  state.connected = connected;
  elements.connection.classList.toggle("is-online", connected);
  elements.connection.classList.toggle("is-offline", !connected);
  elements.connectionCopy.textContent = copy;
  elements.connection.title = copy;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function refreshSnapshot({ preserveDetail = true } = {}) {
  try {
    state.snapshot = await request("/api/v1/sessions");
    setConnection(true, "Live");
    if (state.selectedId && preserveDetail) {
      const stillExists = state.snapshot.sessions.some((session) => session.id === state.selectedId);
      if (stillExists && state.detail) await loadDetail(state.selectedId, { renderAfter: false });
      else if (!stillExists) clearSelection();
    }
    render();
  } catch (error) {
    setConnection(false, "Offline");
    showToast(error.message);
  }
}

async function loadDetail(id, { renderAfter = true } = {}) {
  try {
    state.detail = await request(`/api/v1/sessions/${encodeURIComponent(id)}`);
    if (renderAfter) {
      updateSessionSelection();
      renderDetail();
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function selectSession(id) {
  state.selectedId = id;
  updateSessionSelection();
  await loadDetail(id);
}

async function openSession(session) {
  if (desktop && session.focusable) await activateSession(session);
  else await selectSession(session.id);
}

async function activateSession(session) {
  if (state.focusInFlightId) return;
  state.selectedId = session.id;
  updateSessionSelection();
  if (!desktop) {
    await selectSession(session.id);
    return;
  }

  state.focusInFlightId = session.id;
  setSessionJumping(session.id, true);
  showToast(`Switching to ${HARNESS_LABELS[session.harness] || session.harness}…`);
  try {
    const result = await desktop.focusSession(session.id);
    showToast(result.message);
    if (result.ok) {
      if (state.terminalRepairId === session.id) state.terminalRepairId = null;
      state.selectedId = null;
      state.detail = null;
      document.body.classList.remove("detail-open");
      updateSessionSelection();
    } else {
      if (result.code === "gnome_terminal_unlinked") state.terminalRepairId = session.id;
      await selectSession(session.id);
    }
  } catch (error) {
    showToast(error.message);
    await selectSession(session.id);
  } finally {
    state.focusInFlightId = null;
    setSessionJumping(session.id, false);
  }
}

async function linkTerminal(session) {
  if (!desktop?.linkSession) return;
  try {
    const result = await desktop.linkSession(session.id);
    showToast(result.message);
    if (result.ok) {
      state.terminalRepairId = null;
      await loadDetail(session.id);
    }
  } catch (error) {
    showToast(error.message);
  }
}

function clearSelection() {
  state.selectedId = null;
  state.detail = null;
  document.body.classList.remove("detail-open");
  updateSessionSelection();
}

async function runSessionAction(id, action, message) {
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
    if (action === "dismiss") clearSelection();
    await refreshSnapshot();
    if (message) showToast(message);
  } catch (error) {
    showToast(error.message);
  }
}

function setReadState(session) {
  return runSessionAction(session.id, session.unread ? "seen" : "unread", session.unread ? "Marked seen" : "Marked unread");
}

async function copyLocation(value) {
  try {
    await navigator.clipboard.writeText(value);
    showToast("Location copied");
  } catch {
    showToast("Clipboard access is unavailable");
  }
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function connectStream() {
  const stream = new EventSource("/api/v1/stream");
  stream.addEventListener("ready", () => setConnection(true, "Live"));
  stream.addEventListener("update", () => {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => refreshSnapshot(), 70);
  });
  stream.onerror = () => setConnection(false, "Reconnecting");
}

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((candidate) => {
      candidate.classList.toggle("is-active", candidate === button);
    });
    renderSessions();
  });
});

function setToolsOpen(open) {
  state.toolsOpen = Boolean(open);
  elements.controlDeck.hidden = !state.toolsOpen;
  elements.toolsToggle.setAttribute("aria-expanded", String(state.toolsOpen));
  elements.toolsToggle.classList.toggle("is-active", state.toolsOpen);
}

elements.toolsToggle.addEventListener("click", () => {
  setToolsOpen(!state.toolsOpen);
  if (state.toolsOpen && !elements.search.disabled) elements.search.focus();
});

elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  renderSessions();
});

elements.detailClose.addEventListener("click", () => {
  clearSelection();
  renderDetail();
});

function highlightSession(id) {
  state.selectedId = id;
  state.detail = null;
  document.body.classList.remove("detail-open");
  updateSessionSelection();
}

function focusSessionRow(id) {
  const row = elements.groups.querySelector(`.session-row[data-session-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "nearest", inline: "nearest" });
  row.querySelector(".session-open")?.focus({ preventScroll: true });
}

document.addEventListener("keydown", async (event) => {
  const isTyping = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (event.key === "/" && !isTyping) {
    event.preventDefault();
    setToolsOpen(true);
    elements.search.focus();
    return;
  }
  if (isTyping) {
    if (event.key === "Escape") {
      if (state.query) {
        elements.search.value = "";
        state.query = "";
        renderSessions();
      } else {
        elements.search.blur();
        setToolsOpen(false);
      }
    }
    return;
  }

  const sessions = filteredSessions();
  const currentIndex = sessions.findIndex((session) => session.id === state.selectedId);
  const navigation = sessionNavigationCommand(event.key, currentIndex, sessions.length);
  if (navigation?.action === "select") {
    event.preventDefault();
    const session = sessions[navigation.index];
    highlightSession(session.id);
    focusSessionRow(session.id);
  } else if (navigation?.action === "activate" && event.target.closest?.(".session-open")) {
    event.preventDefault();
    await openSession(sessions[navigation.index]);
  } else if (event.key.toLowerCase() === "i" && state.selectedId) {
    event.preventDefault();
    await selectSession(state.selectedId);
  } else if (event.key.toLowerCase() === "m" && state.detail?.session) {
    event.preventDefault();
    await setReadState(state.detail.session);
  } else if (event.key === "Escape" && state.detail) {
    clearSelection();
    renderDetail();
  } else if (event.key === "Escape" && state.toolsOpen) {
    setToolsOpen(false);
  }
});

function applyDesktopState(nextState) {
  state.desktopState = nextState;
  document.documentElement.classList.toggle("desktop-collapsed", Boolean(nextState?.collapsed));
  document.documentElement.classList.toggle("hard-pinned", Boolean(nextState?.hardPinned));
  elements.search.disabled = false;
  elements.search.placeholder = "Search";
  elements.desktopDock.setAttribute("aria-expanded", String(!nextState?.collapsed));
}

async function initializeDesktopShell() {
  if (!desktop) return;
  document.documentElement.classList.add("desktop-shell");
  elements.desktopTitlebar.hidden = false;
  applyDesktopState(await desktop.getState());
  desktop.onStateChanged(applyDesktopState);
  elements.desktopMinimize.addEventListener("click", async () => applyDesktopState(await desktop.minimize()));
  elements.desktopHide.addEventListener("click", async () => applyDesktopState(await desktop.hide()));
  elements.desktopDock.addEventListener("click", async () => applyDesktopState(await desktop.expand()));
}

async function bootstrap() {
  try {
    await initializeDesktopShell();
    const credentials = await request("/api/v1/client-token");
    state.token = credentials.token;
    await refreshSnapshot({ preserveDetail: false });
    connectStream();
    setInterval(() => refreshSnapshot(), 30_000);
    setInterval(updateRelativeTimes, 20_000);
  } catch (error) {
    setConnection(false, "Offline");
    showToast(error.message);
  }
}

bootstrap();
