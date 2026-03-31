const BASE_PATH = "/__edge-watch";
const WS_PATH_RE = /^\/__edge-watch\/ws\/(\d+)$/;
const SNAPSHOT_PATH_RE = /^\/__edge-watch\/snapshot\/(\d+)$/;
const PUBLISH_PATH_RE = /^\/__edge-watch\/publish\/(\d+)$/;
const DEFAULT_SHARD_COUNT = 4;
const ACTIVE_SHARD_TTL_MS = 60_000;
const ACTIVE_SHARDS_KEY = "activeShards";
const INTERNAL_AUTH_HEADER = "x-edge-internal-authenticated";

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

function badRequest(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, { status });
}

function toMatchId(rawValue) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function matchHubName(matchId) {
  return `match:${matchId}`;
}

function shardHubName(matchId, shardIndex) {
  return `${matchHubName(matchId)}:shard:${shardIndex}`;
}

function toShardCount(rawValue, fallback = DEFAULT_SHARD_COUNT) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(128, value));
}

function toShardIndex(rawValue, shardCount) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(shardCount - 1, value);
}

function parseShardKey(rawValue) {
  const value = Number.parseInt(String(rawValue || "").trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : -1;
}

function listChangedFields(previous, next, fields) {
  const changed = [];
  for (const field of fields) {
    const left = previous?.[field] ?? null;
    const right = next?.[field] ?? null;
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changed.push(field);
    }
  }
  return changed;
}

function buildSnapshotDiff(previous, next) {
  const changes = [];

  const topLevelMap = [
    { provider: "livekora", field: "stream_url_4" },
    { provider: "beinlive", field: "stream_url" },
    { provider: "siiir", field: "stream_url_2" },
    { provider: "yallashoot", field: "stream_url_5" },
  ];

  for (const item of topLevelMap) {
    if ((previous?.[item.field] ?? null) !== (next?.[item.field] ?? null)) {
      changes.push({ provider: item.provider, fields: [item.field] });
    }
  }

  const providerStatusFields = ["state", "playlistUrl", "currentSource", "reason", "phase", "progressPct", "sourceUrl"];
  for (const provider of ["livekora", "beinlive", "siiir", "yallashoot"]) {
    const statusKey = `${provider}Status`;
    const changedFields = listChangedFields(previous?.[statusKey], next?.[statusKey], providerStatusFields);
    if (changedFields.length) {
      changes.push({ provider, fields: changedFields });
    }
  }

  return changes;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPublishRequest(request, env) {
  const secret = String(env.WATCH_EDGE_PUBLISH_SECRET || "").trim();
  if (!secret) {
    return { ok: false, response: badRequest("missing-publish-secret", 500) };
  }

  const timestampHeader = String(request.headers.get("x-tf-edge-timestamp") || "").trim();
  const signatureHeader = String(request.headers.get("x-tf-edge-signature") || "").trim().toLowerCase();
  if (!timestampHeader || !signatureHeader) {
    return { ok: false, response: badRequest("missing-signature", 401) };
  }

  const timestampSec = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    return { ok: false, response: badRequest("invalid-timestamp", 401) };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > 90) {
    return { ok: false, response: badRequest("stale-signature", 401) };
  }

  const bodyText = await request.text();
  const expectedSignature = await hmacSha256Hex(secret, `${timestampHeader}.${bodyText}`);
  if (!constantTimeEqual(expectedSignature, signatureHeader)) {
    return { ok: false, response: badRequest("invalid-signature", 401) };
  }

  return { ok: true, bodyText };
}

function normalizeSnapshotPayload(matchId, payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    matchId,
    version: payload?.version ? String(payload.version) : null,
    updatedAt: payload?.updatedAt ? String(payload.updatedAt) : new Date().toISOString(),
    stream_url: payload?.stream_url ? String(payload.stream_url) : null,
    stream_url_2: payload?.stream_url_2 ? String(payload.stream_url_2) : null,
    stream_url_5: payload?.stream_url_5 ? String(payload.stream_url_5) : null,
    stream_url_4: payload?.stream_url_4 ? String(payload.stream_url_4) : null,
    livekoraStatus: payload?.livekoraStatus && typeof payload.livekoraStatus === "object" ? payload.livekoraStatus : null,
    beinliveStatus: payload?.beinliveStatus && typeof payload.beinliveStatus === "object" ? payload.beinliveStatus : null,
    siiirStatus: payload?.siiirStatus && typeof payload.siiirStatus === "object" ? payload.siiirStatus : null,
    yallashootStatus:
      payload?.yallashootStatus && typeof payload.yallashootStatus === "object" ? payload.yallashootStatus : null,
  };
}

function isInternalRequest(request) {
  return String(request.headers.get(INTERNAL_AUTH_HEADER) || "").trim() === "1";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const shardCount = toShardCount(env.WATCH_EDGE_SHARD_COUNT, DEFAULT_SHARD_COUNT);

    if (request.method === "GET" && url.pathname === `${BASE_PATH}/healthz`) {
      return jsonResponse({
        ok: true,
        service: "tf-watch-edge",
        shardCount,
        activeShardTtlMs: ACTIVE_SHARD_TTL_MS,
        ts: new Date().toISOString(),
      });
    }

    const wsMatch = url.pathname.match(WS_PATH_RE);
    if (request.method === "GET" && wsMatch?.[1]) {
      const matchId = toMatchId(wsMatch[1]);
      if (!matchId) return badRequest("invalid-match-id");
      const shardIndex = toShardIndex(url.searchParams.get("shard"), shardCount);
      const stub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(shardHubName(matchId, shardIndex)));
      return stub.fetch(
        new Request(`https://match-hub.internal/ws?matchId=${matchId}&shard=${shardIndex}&shards=${shardCount}`, {
          method: "GET",
          headers: request.headers,
        })
      );
    }

    const snapshotMatch = url.pathname.match(SNAPSHOT_PATH_RE);
    if (request.method === "GET" && snapshotMatch?.[1]) {
      const matchId = toMatchId(snapshotMatch[1]);
      if (!matchId) return badRequest("invalid-match-id");
      const shouldAggregate = String(url.searchParams.get("aggregate") || "").trim() === "1";
      if (shouldAggregate) {
        const rootStub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(matchHubName(matchId)));
        const rootResponse = await rootStub.fetch(`https://match-hub.internal/root-snapshot?matchId=${matchId}&shards=${shardCount}`, {
          headers: {
            [INTERNAL_AUTH_HEADER]: "1",
          },
        });
        const rootPayload = await rootResponse.json().catch(() => null);
        const snapshots = await Promise.all(
          Array.from({ length: shardCount }, async (_, shardIndex) => {
            const stub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(shardHubName(matchId, shardIndex)));
            const response = await stub.fetch(
              `https://match-hub.internal/snapshot?matchId=${matchId}&shard=${shardIndex}&shards=${shardCount}`
            );
            const payload = await response.json().catch(() => null);
            return {
              shardIndex,
              ok: response.ok,
              payload,
            };
          })
        );
        const totalConnections = snapshots.reduce((sum, item) => {
          return sum + Number(item?.payload?.connections || 0);
        }, 0);
        return jsonResponse({
          ok: true,
          matchId,
          shardCount,
          totalConnections,
          version: rootPayload?.version || null,
          updatedAt: rootPayload?.updatedAt || null,
          snapshot: rootPayload?.snapshot || null,
          activeShards: Array.isArray(rootPayload?.activeShards) ? rootPayload.activeShards : [],
          shards: snapshots.map((item) => ({
            shard: item.shardIndex,
            connections: Number(item?.payload?.connections || 0),
          })),
        });
      }
      const shardIndex = toShardIndex(url.searchParams.get("shard"), shardCount);
      const stub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(shardHubName(matchId, shardIndex)));
      return stub.fetch(`https://match-hub.internal/snapshot?matchId=${matchId}&shard=${shardIndex}&shards=${shardCount}`);
    }

    const publishMatch = url.pathname.match(PUBLISH_PATH_RE);
    if (request.method === "POST" && publishMatch?.[1]) {
      const matchId = toMatchId(publishMatch[1]);
      if (!matchId) return badRequest("invalid-match-id");
      const verification = await verifyPublishRequest(request, env);
      if (!verification.ok) return verification.response;
      const rootStub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(matchHubName(matchId)));
      return rootStub.fetch("https://match-hub.internal/publish-root", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          [INTERNAL_AUTH_HEADER]: "1",
          "x-edge-match-id": String(matchId),
          "x-edge-shard-count": String(shardCount),
        },
        body: verification.bodyText,
      });
    }

    return badRequest("not-found", 404);
  },
};

export class MatchHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.snapshotCache = null;
    this.activeShardsCache = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/root-snapshot") {
      if (!isInternalRequest(request)) {
        return badRequest("unauthorized", 401);
      }
      const shardCount = toShardCount(url.searchParams.get("shards"), DEFAULT_SHARD_COUNT);
      const snapshot = await this.readSnapshot();
      const activeShards = await this.listActiveShardStates(shardCount);
      return jsonResponse({
        ok: true,
        matchId: snapshot?.matchId || toMatchId(url.searchParams.get("matchId")),
        version: snapshot?.version || null,
        updatedAt: snapshot?.updatedAt || null,
        snapshot,
        activeShards,
      });
    }

    if (request.method === "POST" && url.pathname === "/presence") {
      if (!isInternalRequest(request)) {
        return badRequest("unauthorized", 401);
      }
      const matchId = toMatchId(request.headers.get("x-edge-match-id"));
      const shardCount = toShardCount(request.headers.get("x-edge-shard-count"), DEFAULT_SHARD_COUNT);
      const shardIndex = toShardIndex(request.headers.get("x-edge-shard-index"), shardCount);
      if (!matchId) return badRequest("invalid-match-id");

      let payload = null;
      try {
        payload = await request.json();
      } catch {
        return badRequest("invalid-json", 400);
      }

      const connections = Math.max(0, Number.parseInt(String(payload?.connections ?? 0), 10) || 0);
      const activeShards = await this.updateShardPresence(shardCount, shardIndex, connections);
      return jsonResponse({
        ok: true,
        matchId,
        shardCount,
        shardIndex,
        connections,
        activeShards,
      });
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const matchId = toMatchId(url.searchParams.get("matchId"));
      let snapshot = await this.readSnapshot();
      if (!snapshot && matchId) {
        snapshot = await this.syncSnapshotFromRoot(
          matchId,
          toShardCount(url.searchParams.get("shards"), DEFAULT_SHARD_COUNT)
        );
      }
      return jsonResponse({
        ok: true,
        matchId: snapshot?.matchId || matchId,
        shard: toShardIndex(url.searchParams.get("shard"), toShardCount(url.searchParams.get("shards"), DEFAULT_SHARD_COUNT)),
        version: snapshot?.version || null,
        updatedAt: snapshot?.updatedAt || null,
        snapshot,
        connections: this.state.getWebSockets().length,
      });
    }

    if (request.method === "GET" && url.pathname === "/ws") {
      const upgrade = String(request.headers.get("Upgrade") || "").toLowerCase();
      if (upgrade !== "websocket") {
        return badRequest("expected-websocket-upgrade", 426);
      }

      const matchId = toMatchId(url.searchParams.get("matchId"));
      if (!matchId) return badRequest("invalid-match-id");

      const shardCount = toShardCount(url.searchParams.get("shards"), DEFAULT_SHARD_COUNT);
      const shardIndex = toShardIndex(url.searchParams.get("shard"), shardCount);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      server.serializeAttachment({ matchId, shardIndex, shardCount });
      await this.reportShardPresence(matchId, shardIndex, shardCount, this.state.getWebSockets().length);
      server.send(
        JSON.stringify({
          type: "connected",
          matchId,
          shard: shardIndex,
          ts: new Date().toISOString(),
        })
      );

      const snapshot = (await this.syncSnapshotFromRoot(matchId, shardCount)) || (await this.readSnapshot());
      if (snapshot) {
        server.send(
          JSON.stringify({
            type: "snapshot",
            matchId: snapshot.matchId || matchId,
            version: snapshot.version || null,
            updatedAt: snapshot.updatedAt || null,
            payload: snapshot,
          })
        );
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/publish-root") {
      if (!isInternalRequest(request)) {
        return badRequest("unauthorized", 401);
      }

      const matchId = toMatchId(request.headers.get("x-edge-match-id"));
      const shardCount = toShardCount(request.headers.get("x-edge-shard-count"), DEFAULT_SHARD_COUNT);
      if (!matchId) return badRequest("invalid-match-id");

      let payload = null;
      try {
        payload = await request.json();
      } catch {
        return badRequest("invalid-json", 400);
      }

      const normalizedSnapshot = normalizeSnapshotPayload(matchId, payload);
      if (!normalizedSnapshot) {
        return badRequest("invalid-payload", 400);
      }

      await this.writeSnapshot(normalizedSnapshot);
      const activeShards = await this.listActiveShardStates(shardCount);
      const activeShardIndices = activeShards.map((item) => item.shardIndex);
      const bodyText = JSON.stringify(normalizedSnapshot);
      const results = await Promise.all(
        activeShardIndices.map(async (shardIndex) => {
          const stub = this.env.MATCH_HUB.get(this.env.MATCH_HUB.idFromName(shardHubName(matchId, shardIndex)));
          const response = await stub.fetch("https://match-hub.internal/publish-shard", {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8",
              [INTERNAL_AUTH_HEADER]: "1",
              "x-edge-match-id": String(matchId),
              "x-edge-shard-index": String(shardIndex),
            },
            body: bodyText,
          });
          const publishPayload = await response.json().catch(() => null);
          return {
            shardIndex,
            ok: response.ok,
            payload: publishPayload,
          };
        })
      );

      return jsonResponse({
        ok: results.every((item) => item.ok),
        matchId,
        shardCount,
        version: normalizedSnapshot.version,
        updatedAt: normalizedSnapshot.updatedAt,
        activeShardCount: activeShardIndices.length,
        activeShards: activeShardIndices,
      });
    }

    if (request.method === "POST" && url.pathname === "/publish-shard") {
      if (!isInternalRequest(request)) {
        return badRequest("unauthorized", 401);
      }

      const matchId = toMatchId(request.headers.get("x-edge-match-id"));
      if (!matchId) return badRequest("invalid-match-id");

      let payload = null;
      try {
        payload = await request.json();
      } catch {
        return badRequest("invalid-json", 400);
      }

      const normalizedSnapshot = normalizeSnapshotPayload(matchId, payload);
      if (!normalizedSnapshot) {
        return badRequest("invalid-payload", 400);
      }

      const previousSnapshot = await this.readSnapshot();
      await this.writeSnapshot(normalizedSnapshot);
      const changes = buildSnapshotDiff(previousSnapshot, normalizedSnapshot);
      this.broadcast({
        type: "watch-state-diff",
        matchId,
        version: normalizedSnapshot.version,
        updatedAt: normalizedSnapshot.updatedAt,
        changes,
      });

      return jsonResponse({
        ok: true,
        matchId,
        version: normalizedSnapshot.version,
        updatedAt: normalizedSnapshot.updatedAt,
        connections: this.state.getWebSockets().length,
      });
    }

    return badRequest("not-found", 404);
  }

  async readSnapshot() {
    if (this.snapshotCache) return this.snapshotCache;
    const snapshot = await this.state.storage.get("snapshot");
    this.snapshotCache = snapshot || null;
    return this.snapshotCache;
  }

  async writeSnapshot(snapshot) {
    this.snapshotCache = snapshot;
    await this.state.storage.put("snapshot", snapshot);
  }

  async readActiveShards() {
    if (this.activeShardsCache) return this.activeShardsCache;
    const activeShards = await this.state.storage.get(ACTIVE_SHARDS_KEY);
    this.activeShardsCache = activeShards && typeof activeShards === "object" ? activeShards : {};
    return this.activeShardsCache;
  }

  async writeActiveShards(activeShards) {
    const normalized = {};
    for (const [rawShardIndex, value] of Object.entries(activeShards || {})) {
      const shardIndex = parseShardKey(rawShardIndex);
      const connections = Math.max(0, Number.parseInt(String(value?.connections ?? 0), 10) || 0);
      const lastSeen = Number.parseInt(String(value?.lastSeen ?? 0), 10);
      if (shardIndex < 0 || !Number.isFinite(lastSeen) || lastSeen <= 0) continue;
      normalized[String(shardIndex)] = {
        connections,
        lastSeen,
      };
    }
    this.activeShardsCache = normalized;
    await this.state.storage.put(ACTIVE_SHARDS_KEY, normalized);
  }

  async listActiveShardStates(shardCount) {
    const now = Date.now();
    const current = await this.readActiveShards();
    const next = {};

    for (const [rawShardIndex, value] of Object.entries(current || {})) {
      const shardIndex = parseShardKey(rawShardIndex);
      if (shardIndex < 0 || shardIndex >= shardCount) continue;
      const connections = Math.max(0, Number.parseInt(String(value?.connections ?? 0), 10) || 0);
      const lastSeen = Number.parseInt(String(value?.lastSeen ?? 0), 10);
      if (!Number.isFinite(lastSeen) || lastSeen <= 0) continue;
      if (connections > 0 || now - lastSeen <= ACTIVE_SHARD_TTL_MS) {
        next[String(shardIndex)] = {
          connections,
          lastSeen,
        };
      }
    }

    const changed = JSON.stringify(current || {}) !== JSON.stringify(next);
    if (changed) {
      await this.writeActiveShards(next);
    }

    return Object.entries(next)
      .map(([rawShardIndex, value]) => ({
        shardIndex: Number.parseInt(rawShardIndex, 10),
        connections: Math.max(0, Number.parseInt(String(value?.connections ?? 0), 10) || 0),
        lastSeen: Number.parseInt(String(value?.lastSeen ?? 0), 10) || now,
      }))
      .sort((left, right) => left.shardIndex - right.shardIndex);
  }

  async updateShardPresence(shardCount, shardIndex, connections) {
    const current = await this.readActiveShards();
    const next = { ...(current || {}) };
    if (connections > 0) {
      next[String(shardIndex)] = {
        connections,
        lastSeen: Date.now(),
      };
    } else {
      delete next[String(shardIndex)];
    }
    await this.writeActiveShards(next);
    return this.listActiveShardStates(shardCount);
  }

  async fetchRootSnapshot(matchId, shardCount = DEFAULT_SHARD_COUNT) {
    const rootStub = this.env.MATCH_HUB.get(this.env.MATCH_HUB.idFromName(matchHubName(matchId)));
    const response = await rootStub.fetch(
      `https://match-hub.internal/root-snapshot?matchId=${matchId}&shards=${shardCount}`,
      {
      headers: {
        [INTERNAL_AUTH_HEADER]: "1",
      },
      }
    );
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null);
    return payload?.snapshot || null;
  }

  async syncSnapshotFromRoot(matchId, shardCount = DEFAULT_SHARD_COUNT) {
    const rootSnapshot = await this.fetchRootSnapshot(matchId, shardCount);
    if (!rootSnapshot) {
      return this.readSnapshot();
    }
    const localSnapshot = await this.readSnapshot();
    if (
      !localSnapshot ||
      localSnapshot.version !== rootSnapshot.version ||
      localSnapshot.updatedAt !== rootSnapshot.updatedAt
    ) {
      await this.writeSnapshot(rootSnapshot);
    }
    return rootSnapshot;
  }

  async reportShardPresence(matchId, shardIndex, shardCount, connections) {
    if (!matchId || shardIndex < 0) return;
    const rootStub = this.env.MATCH_HUB.get(this.env.MATCH_HUB.idFromName(matchHubName(matchId)));
    try {
      await rootStub.fetch("https://match-hub.internal/presence", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          [INTERNAL_AUTH_HEADER]: "1",
          "x-edge-match-id": String(matchId),
          "x-edge-shard-index": String(shardIndex),
          "x-edge-shard-count": String(shardCount),
        },
        body: JSON.stringify({
          connections,
        }),
      });
    } catch {}
  }

  broadcast(payload) {
    const body = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(body);
      } catch {}
    }
  }

  webSocketMessage(ws, message) {
    const attachment =
      typeof ws.deserializeAttachment === "function"
        ? ws.deserializeAttachment() || null
        : null;
    const text = typeof message === "string" ? message : "";
    if (text === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", ts: new Date().toISOString() }));
      } catch {}
      if (attachment?.matchId) {
        this.reportShardPresence(
          attachment.matchId,
          attachment.shardIndex,
          attachment.shardCount || DEFAULT_SHARD_COUNT,
          this.state.getWebSockets().length
        ).catch(() => {});
      }
      return;
    }

    if (text === "snapshot") {
      this.readSnapshot()
        .then((snapshot) => {
          try {
            ws.send(
              JSON.stringify({
                type: "snapshot",
                matchId: snapshot?.matchId || null,
                version: snapshot?.version || null,
                updatedAt: snapshot?.updatedAt || null,
                payload: snapshot,
              })
            );
          } catch {}
        })
        .catch(() => {});
    }
  }

  webSocketClose(ws) {
    const attachment =
      typeof ws.deserializeAttachment === "function"
        ? ws.deserializeAttachment() || null
        : null;
    if (attachment?.matchId) {
      const remainingConnections = this.state.getWebSockets().filter((socket) => socket !== ws).length;
      this.reportShardPresence(
        attachment.matchId,
        attachment.shardIndex,
        attachment.shardCount || DEFAULT_SHARD_COUNT,
        remainingConnections
      ).catch(() => {});
    }
  }
}
