import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import { APP_NAME, APP_VERSION } from "./config.js";

const MAX_BODY_BYTES = 256 * 1024;

const ASSETS = new Map([
  ["/", { type: "text/html; charset=utf-8", body: readFileSync(new URL("../web/index.html", import.meta.url)) }],
  ["/index.html", { type: "text/html; charset=utf-8", body: readFileSync(new URL("../web/index.html", import.meta.url)) }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("../web/app.js", import.meta.url)) }],
  ["/styles.css", { type: "text/css; charset=utf-8", body: readFileSync(new URL("../web/styles.css", import.meta.url)) }],
  ["/favicon.svg", { type: "image/svg+xml", body: readFileSync(new URL("../web/favicon.svg", import.meta.url)) }],
  [
    "/manifest.webmanifest",
    { type: "application/manifest+json", body: readFileSync(new URL("../web/manifest.webmanifest", import.meta.url)) },
  ],
]);

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
});

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendAsset(response, asset) {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": asset.type,
    "Cache-Control": "no-cache",
  });
  response.end(asset.body);
}

function tokensMatch(expected, received) {
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(request, token) {
  const authorization = request.headers.authorization || "";
  return authorization.startsWith("Bearer ") && tokensMatch(token, authorization.slice(7));
}

function hostnameFromHeader(hostHeader) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedHost(hostHeader, bindHost) {
  const requested = hostnameFromHeader(hostHeader);
  const configured = String(bindHost).replace(/^\[|\]$/g, "").toLowerCase();
  if (!requested) return false;
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (loopback.has(configured)) return loopback.has(requested);
  if (["0.0.0.0", "::"].includes(configured)) return requested === "localhost" || Boolean(isIP(requested));
  return requested === configured;
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function decodeRoutePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function createSwitchboardServer({
  store,
  token,
  host = "127.0.0.1",
  port = 43117,
  recentHours = 24,
  maxRecent = 20,
  logger = console,
}) {
  const startedAt = Date.now();
  const streams = new Set();

  const broadcast = (message) => {
    const frame = `event: update\ndata: ${JSON.stringify(message)}\n\n`;
    for (const response of streams) {
      try {
        response.write(frame);
      } catch {
        streams.delete(response);
      }
    }
  };
  store.on("changed", broadcast);

  const server = http.createServer(async (request, response) => {
    try {
      if (!isAllowedHost(request.headers.host, host)) {
        sendJson(response, 421, { error: "Host is not allowed" });
        return;
      }
      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      const pathname = url.pathname;

      if (request.method === "GET" && ASSETS.has(pathname)) {
        sendAsset(response, ASSETS.get(pathname));
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/health") {
        sendJson(response, 200, {
          status: "ok",
          name: APP_NAME,
          version: APP_VERSION,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          adapters: store.listAdapterHealth(),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/client-token") {
        sendJson(response, 200, { token });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/sessions") {
        sendJson(response, 200, store.getSnapshot({ recentHours, maxRecent }));
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/stream") {
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ version: APP_VERSION })}\n\n`);
        streams.add(response);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
        heartbeat.unref?.();
        request.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(response);
        });
        return;
      }

      const detailMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (request.method === "GET" && detailMatch) {
        const id = decodeRoutePart(detailMatch[1]);
        const detail = id ? store.getSessionDetail(id) : null;
        if (!detail) sendJson(response, 404, { error: "Session not found" });
        else sendJson(response, 200, detail);
        return;
      }

      if (request.method === "POST" && !isAuthorized(request, token)) {
        sendJson(response, 401, { error: "A valid local ingest token is required" });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/events") {
        const body = await readJson(request);
        const events = Array.isArray(body) ? body : [body];
        if (events.length > 64) {
          sendJson(response, 413, { error: "At most 64 events can be ingested at once" });
          return;
        }
        const results = events.map((event) => {
          const result = store.ingest(event);
          if (result.accepted && event?.harness) {
            store.setAdapterHealth(event.harness, {
              status: "ready",
              detail: `Last event: ${event.nativeType || event.kind || "unknown"}`,
            });
          }
          return result;
        });
        sendJson(response, 202, {
          accepted: results.filter((result) => result.accepted).length,
          duplicates: results.filter((result) => result.duplicate).length,
          sessions: results.map((result) => result.session?.id).filter(Boolean),
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/demo/clear") {
        sendJson(response, 200, store.clearDemoData());
        return;
      }

      const actionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/(seen|unread|dismiss)$/);
      if (request.method === "POST" && actionMatch) {
        const id = decodeRoutePart(actionMatch[1]);
        const action = actionMatch[2];
        const session =
          action === "seen"
            ? store.markSeen(id)
            : action === "unread"
              ? store.markUnread(id)
              : store.dismiss(id);
        if (!session) sendJson(response, 404, { error: "Session not found" });
        else sendJson(response, 200, { session });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      if (status >= 500) logger.error?.(error.stack || error.message);
      sendJson(response, status, { error: status >= 500 ? "Internal server error" : error.message });
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    host,
    port,
    server,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    },
    stop() {
      store.off("changed", broadcast);
      for (const response of streams) response.end();
      streams.clear();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
