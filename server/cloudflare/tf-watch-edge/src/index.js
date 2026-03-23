const BASE_PATH = "/__edge-watch";
const WS_PATH_RE = /^\/__edge-watch\/ws\/(\d+)$/;
const SNAPSHOT_PATH_RE = /^\/__edge-watch\/snapshot\/(\d+)$/;
const PUBLISH_PATH_RE = /^\/__edge-watch\/publish\/(\d+)$/;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === `${BASE_PATH}/healthz`) {
      return jsonResponse({
        ok: true,
        service: "tf-watch-edge",
        ts: new Date().toISOString(),
      });
    }

    const wsMatch = url.pathname.match(WS_PATH_RE);
    if (request.method === "GET" && wsMatch?.[1]) {
      const matchId = toMatchId(wsMatch[1]);
      if (!matchId) return badRequest("invalid-match-id");
      const stub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(matchHubName(matchId)));
      return stub.fetch(`https://match-hub.internal/ws?matchId=${matchId}`);
    }

    const snapshotMatch = url.pathname.match(SNAPSHOT_PATH_RE);
    if (request.method === "GET" && snapshotMatch?.[1]) {
      const matchId = toMatchId(snapshotMatch[1]);
      if (!matchId) return badRequest("invalid-match-id");
      const stub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(matchHubName(matchId)));
      return stub.fetch(`https://match-hub.internal/snapshot?matchId=${matchId}`);
    }

    const publishMatch = url.pathname.match(PUBLISH_PATH_RE);
    if (request.method === "POST" && publishMatch?.[1]) {
      const matchId = toMatchId(publishMatch[1]);
      if (!matchId) return badRequest("invalid-match-id");
      const verification = await verifyPublishRequest(request, env);
      if (!verification.ok) return verification.response;
      const stub = env.MATCH_HUB.get(env.MATCH_HUB.idFromName(matchHubName(matchId)));
      return stub.fetch("https://match-hub.internal/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-edge-publish-authenticated": "1",
          "x-edge-match-id": String(matchId),
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
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const snapshot = await this.readSnapshot();
      return jsonResponse({
        ok: true,
        matchId: snapshot?.matchId || toMatchId(url.searchParams.get("matchId")),
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

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);
      server.serializeAttachment({ matchId });
      server.send(
        JSON.stringify({
          type: "connected",
          matchId,
          ts: new Date().toISOString(),
        })
      );

      const snapshot = await this.readSnapshot();
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

    if (request.method === "POST" && url.pathname === "/publish") {
      if (String(request.headers.get("x-edge-publish-authenticated") || "").trim() !== "1") {
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

      const normalized = {
        type: String(payload?.type || "watch-state-change").trim() || "watch-state-change",
        matchId,
        version: payload?.version ? String(payload.version) : null,
        updatedAt: payload?.updatedAt ? String(payload.updatedAt) : new Date().toISOString(),
        provider: payload?.provider ? String(payload.provider) : null,
        payload: payload?.payload && typeof payload.payload === "object" ? payload.payload : payload,
        receivedAt: new Date().toISOString(),
      };

      await this.writeSnapshot(normalized);
      this.broadcast({
        type: normalized.type,
        matchId: normalized.matchId,
        version: normalized.version,
        updatedAt: normalized.updatedAt,
        provider: normalized.provider,
        payload: normalized.payload,
      });

      return jsonResponse({
        ok: true,
        matchId,
        version: normalized.version,
        updatedAt: normalized.updatedAt,
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

  broadcast(payload) {
    const body = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(body);
      } catch {}
    }
  }

  webSocketMessage(ws, message) {
    const text = typeof message === "string" ? message : "";
    if (text === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", ts: new Date().toISOString() }));
      } catch {}
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
    try {
      ws.close(1000, "bye");
    } catch {}
  }
}
