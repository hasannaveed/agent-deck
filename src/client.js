import { existsSync } from "node:fs";
import { getRuntimeConfig, readIngestToken } from "./config.js";

export class SwitchboardClient {
  constructor(config = getRuntimeConfig()) {
    this.config = config;
    this.token = existsSync(config.tokenPath) ? readIngestToken(config) : null;
  }

  refreshToken() {
    this.token = existsSync(this.config.tokenPath) ? readIngestToken(this.config) : null;
    return this.token;
  }

  async request(path, { method = "GET", body, timeoutMs = 3500 } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") {
      const token = this.refreshToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Switchboard returned HTTP ${response.status}`);
    return payload;
  }

  health() {
    return this.request("/api/v1/health");
  }

  sessions() {
    return this.request("/api/v1/sessions");
  }

  session(id) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(id)}`);
  }

  emit(events, { timeoutMs = 3500 } = {}) {
    if (!this.refreshToken()) throw new Error(`Ingest token not found at ${this.config.tokenPath}; start switchboardd first`);
    return this.request("/api/v1/events", { method: "POST", body: events, timeoutMs });
  }

  clearDemoData() {
    if (!this.refreshToken()) throw new Error(`Ingest token not found at ${this.config.tokenPath}; start switchboardd first`);
    return this.request("/api/v1/demo/clear", { method: "POST", body: {} });
  }

  action(id, action) {
    if (!this.refreshToken()) throw new Error(`Ingest token not found at ${this.config.tokenPath}; start switchboardd first`);
    return this.request(`/api/v1/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} });
  }
}
