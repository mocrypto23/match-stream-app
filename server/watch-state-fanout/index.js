#!/usr/bin/env node
"use strict";

const { createHmac } = require("crypto");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("redis");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function toInt(raw, fallback, min = Number.MIN_SAFE_INTEGER) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function writeSseEvent(res, eventName, payload) {
  try {
    if (eventName) {
      res.write(`event: ${eventName}\n`);
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

function hmacSha256Hex(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function trimUrl(rawValue, fallback = "") {
  return String(rawValue || "")
    .trim()
    .replace(/\/+$/, "") || fallback;
}

function compactWatchState(payload) {
  if (!payload || typeof payload !== "object") return null;
  const matchId = Number.parseInt(String(payload.matchId || "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  return {
    matchId,
    version: payload.version ? String(payload.version) : null,
    updatedAt: payload.updatedAt ? String(payload.updatedAt) : nowIso(),
    stream_url: payload.stream_url ? String(payload.stream_url) : null,
    stream_url_2: payload.stream_url_2 ? String(payload.stream_url_2) : null,
    stream_url_5: payload.stream_url_5 ? String(payload.stream_url_5) : null,
    stream_url_4: payload.stream_url_4 ? String(payload.stream_url_4) : null,
    livekoraStatus: payload.livekoraStatus && typeof payload.livekoraStatus === "object" ? payload.livekoraStatus : null,
    beinliveStatus: payload.beinliveStatus && typeof payload.beinliveStatus === "object" ? payload.beinliveStatus : null,
    siiirStatus: payload.siiirStatus && typeof payload.siiirStatus === "object" ? payload.siiirStatus : null,
    yallashootStatus: payload.yallashootStatus && typeof payload.yallashootStatus === "object" ? payload.yallashootStatus : null,
  };
}

class FanoutServer {
  constructor(config) {
    this.config = config;
    this.clientsByMatchId = new Map();
    this.snapshotVersionByMatchId = new Map();
    this.snapshotRefreshPromises = new Map();
    this.snapshotRefreshPending = new Set();
    this.server = null;
    this.redisSub = null;
    this.heartbeatTimer = null;
  }

  log(level, message, meta = null) {
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    process.stdout.write(`[watch-state-fanout] ${level} ${message}${suffix}\n`);
  }

  addClient(matchId, res) {
    let set = this.clientsByMatchId.get(matchId);
    if (!set) {
      set = new Set();
      this.clientsByMatchId.set(matchId, set);
    }
    set.add(res);
  }

  removeClient(matchId, res) {
    const set = this.clientsByMatchId.get(matchId);
    if (!set) return;
    set.delete(res);
    if (!set.size) {
      this.clientsByMatchId.delete(matchId);
    }
  }

  broadcast(matchId, eventName, payload) {
    const set = this.clientsByMatchId.get(matchId);
    if (!set || !set.size) return;
    for (const res of Array.from(set)) {
      writeSseEvent(res, eventName, payload);
    }
  }

  async fetchCompactSnapshot(matchId) {
    const response = await fetch(`${this.config.appBaseUrl}/api/livekora/watch-state/${matchId}`, {
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
      },
      signal: AbortSignal.timeout(this.config.edgePublishTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`watch-state-${response.status}`);
    }
    const payload = await response.json().catch(() => null);
    const snapshot = compactWatchState(payload);
    if (!snapshot) {
      throw new Error("watch-state-invalid");
    }
    return snapshot;
  }

  async publishCompactSnapshot(snapshot) {
    if (!this.config.watchEdgeBaseUrl || !this.config.watchEdgePublishSecret) return;
    const body = JSON.stringify(snapshot);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hmacSha256Hex(this.config.watchEdgePublishSecret, `${timestamp}.${body}`);
    const response = await fetch(`${this.config.watchEdgeBaseUrl}/__edge-watch/publish/${snapshot.matchId}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        "x-tf-edge-timestamp": timestamp,
        "x-tf-edge-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(this.config.edgePublishTimeoutMs),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`edge-publish-${response.status}${errorText ? `:${errorText.slice(0, 160)}` : ""}`);
    }
  }

  async refreshMatchSnapshot(matchId) {
    const snapshot = await this.fetchCompactSnapshot(matchId);
    const version = String(snapshot.version || "").trim();
    if (!version) return;
    if (this.snapshotVersionByMatchId.get(matchId) === version) return;
    await this.publishCompactSnapshot(snapshot);
    this.snapshotVersionByMatchId.set(matchId, version);
  }

  scheduleSnapshotRefresh(matchId) {
    if (!this.config.watchEdgeBaseUrl || !this.config.watchEdgePublishSecret) return;

    if (this.snapshotRefreshPromises.has(matchId)) {
      this.snapshotRefreshPending.add(matchId);
      return;
    }

    const run = (async () => {
      do {
        this.snapshotRefreshPending.delete(matchId);
        try {
          await this.refreshMatchSnapshot(matchId);
        } catch (error) {
          this.log("warn", "edge snapshot refresh failed", {
            matchId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } while (this.snapshotRefreshPending.has(matchId));
    })().finally(() => {
      this.snapshotRefreshPromises.delete(matchId);
      this.snapshotRefreshPending.delete(matchId);
    });

    this.snapshotRefreshPromises.set(matchId, run);
  }

  async startRedis() {
    const sub = createClient({ url: this.config.redisUrl });
    sub.on("error", (error) => {
      this.log("warn", "redis subscriber error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await sub.connect();
    await sub.pSubscribe("watch-state:match:*", (message, channel) => {
      let payload = null;
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }
      const matchFromPayload = Number.parseInt(String(payload?.matchId || "").trim(), 10);
      const channelMatch = Number.parseInt(String(channel || "").split(":").pop() || "", 10);
      const matchId = Number.isFinite(matchFromPayload) ? matchFromPayload : channelMatch;
      if (!Number.isFinite(matchId) || matchId <= 0) return;
      this.broadcast(matchId, "watch-state-change", payload);
      this.scheduleSnapshotRefresh(matchId);
    });
    this.redisSub = sub;
    this.log("info", "redis subscriber connected", { redisUrl: this.config.redisUrl });
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const payload = { ts: nowIso() };
      for (const [matchId] of this.clientsByMatchId) {
        this.broadcast(matchId, "heartbeat", payload);
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  async start() {
    await this.startRedis();
    this.startHeartbeat();
    this.log("info", "edge publisher config", {
      appBaseUrl: this.config.appBaseUrl,
      watchEdgeEnabled: !!(this.config.watchEdgeBaseUrl && this.config.watchEdgePublishSecret),
      watchEdgeBaseUrl: this.config.watchEdgeBaseUrl || null,
    });

    this.server = http.createServer((req, res) => {
      const method = String(req.method || "GET").toUpperCase();
      const parsed = new URL(req.url || "/", `http://${this.config.bind}:${this.config.port}`);

      if (method === "GET" && parsed.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, ts: nowIso(), clients: this.clientCount() });
      }

      const streamMatch = parsed.pathname.match(/^\/api\/livekora\/events\/stream\/(\d+)$/);
      if (method === "GET" && streamMatch && streamMatch[1]) {
        const matchId = Number.parseInt(streamMatch[1], 10);
        if (!Number.isFinite(matchId) || matchId <= 0) {
          return sendJson(res, 400, { error: "invalid-match-id" });
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        writeSseEvent(res, "connected", { matchId, ts: nowIso() });

        this.addClient(matchId, res);
        req.on("close", () => {
          this.removeClient(matchId, res);
          try {
            res.end();
          } catch {}
        });
        return;
      }

      return sendJson(res, 404, { error: "not-found" });
    });

    this.server.listen(this.config.port, this.config.bind, () => {
      this.log("info", "fanout server started", {
        bind: this.config.bind,
        port: this.config.port,
      });
    });
  }

  clientCount() {
    let total = 0;
    for (const set of this.clientsByMatchId.values()) total += set.size;
    return total;
  }
}

function loadConfig() {
  return {
    bind: String(process.env.WATCH_STATE_FANOUT_BIND || "127.0.0.1").trim() || "127.0.0.1",
    port: toInt(process.env.WATCH_STATE_FANOUT_PORT, 3601, 1),
    heartbeatMs: toInt(process.env.WATCH_STATE_FANOUT_HEARTBEAT_MS, 15000, 1000),
    redisUrl: String(process.env.WATCH_STATE_REDIS_URL || "redis://127.0.0.1:6379").trim() || "redis://127.0.0.1:6379",
    appBaseUrl: trimUrl(process.env.WATCH_STATE_APP_BASE_URL, "http://127.0.0.1:3000"),
    watchEdgeBaseUrl: trimUrl(process.env.WATCH_EDGE_BASE_URL, ""),
    watchEdgePublishSecret: String(process.env.WATCH_EDGE_PUBLISH_SECRET || "").trim(),
    edgePublishTimeoutMs: toInt(process.env.WATCH_EDGE_PUBLISH_TIMEOUT_MS, 3000, 250),
  };
}

async function main() {
  const server = new FanoutServer(loadConfig());
  await server.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[watch-state-fanout] fatal: ${message}\n`);
  process.exit(1);
});
