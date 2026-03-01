import { getP2PEligibleServerIds, getRepackEligibleServerIds } from "./server-capabilities";

export type RepackFlags = {
  enabled: boolean;
  repackServers: Set<number>;
  readPct: number;
  readPctByServer: Map<number, number>;
  forceDisableServers: Set<number>;
  p2pServers: Set<number>;
  publicBaseUrl: string;
};

export type RepackDecision = {
  useRepack: boolean;
  reason: string;
  readPct: number;
  bucket: number;
};

function toBool(raw: string | undefined, fallback = false) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function clampPct(raw: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(String(raw || "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(parsed)));
}

function parseServerSet(raw: string | undefined, fallback: number[]) {
  const parts = String(raw || "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return new Set<number>(parts.length ? parts : fallback);
}

function parseReadPctByServer(raw: string | undefined) {
  const out = new Map<number, number>();
  const text = String(raw || "").trim();
  if (!text) return out;
  for (const token of text.split(",")) {
    const [idRaw, pctRaw] = token.split(":");
    const id = Number.parseInt(String(idRaw || "").trim(), 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.set(id, clampPct(pctRaw, 0));
  }
  return out;
}

function normalizePublicBaseUrl(raw: string | undefined) {
  const base = String(raw || "").trim() || "https://r2.tf-player.site/live";
  return base.replace(/\/+$/, "");
}

function fnv1aHash(input: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return hash >>> 0;
}

function getBucketFromHash(input: string) {
  return fnv1aHash(input) % 100;
}

export function getRuntimeRepackFlags(env = process.env): RepackFlags {
  const repackDefaults = getRepackEligibleServerIds();
  const p2pDefaults = getP2PEligibleServerIds();
  const configuredP2P = String(env.P2P_SERVERS || "").trim() || String(env.NEXT_PUBLIC_P2P_SERVERS || "").trim();
  return {
    enabled: toBool(env.REPACK_ENABLED, false),
    repackServers: parseServerSet(env.REPACK_SERVERS, repackDefaults),
    readPct: clampPct(env.REPACK_READ_PCT, 0),
    readPctByServer: parseReadPctByServer(env.REPACK_READ_PCT_BY_SERVER),
    forceDisableServers: parseServerSet(env.REPACK_FORCE_DISABLE_SERVERS, []),
    p2pServers: parseServerSet(configuredP2P, p2pDefaults),
    publicBaseUrl: normalizePublicBaseUrl(env.REPACK_PUBLIC_BASE_URL || env.NEXT_PUBLIC_REPACK_PUBLIC_BASE_URL),
  };
}

export function resolveRepackReadPct(flags: RepackFlags, serverId: number) {
  return flags.readPctByServer.get(serverId) ?? flags.readPct;
}

export function shouldUseRepackForViewer(input: {
  flags: RepackFlags;
  serverId: number;
  matchId: number | null;
  viewerSessionId: string;
}) {
  const { flags, serverId, matchId, viewerSessionId } = input;
  if (!flags.enabled) {
    return { useRepack: false, reason: "disabled", readPct: 0, bucket: -1 } satisfies RepackDecision;
  }
  if (!flags.repackServers.has(serverId)) {
    return { useRepack: false, reason: "server-not-enabled", readPct: 0, bucket: -1 } satisfies RepackDecision;
  }
  if (flags.forceDisableServers.has(serverId)) {
    return { useRepack: false, reason: "force-disabled", readPct: 0, bucket: -1 } satisfies RepackDecision;
  }
  if (!Number.isFinite(matchId) || (matchId || 0) <= 0) {
    return { useRepack: false, reason: "invalid-match", readPct: 0, bucket: -1 } satisfies RepackDecision;
  }
  const pct = resolveRepackReadPct(flags, serverId);
  if (pct <= 0) {
    return { useRepack: false, reason: "pct-0", readPct: pct, bucket: -1 } satisfies RepackDecision;
  }
  if (pct >= 100) {
    return { useRepack: true, reason: "pct-100", readPct: pct, bucket: 0 } satisfies RepackDecision;
  }
  const stickyKey = `${matchId}:${serverId}:${String(viewerSessionId || "anon")}`;
  const bucket = getBucketFromHash(stickyKey);
  return {
    useRepack: bucket < pct,
    reason: bucket < pct ? "bucket-hit" : "bucket-miss",
    readPct: pct,
    bucket,
  } satisfies RepackDecision;
}

export function buildRepackPlaylistUrl(input: {
  baseUrl: string;
  matchId: number;
  serverId: number;
}) {
  const base = normalizePublicBaseUrl(input.baseUrl);
  return `${base}/m${input.matchId}/s${input.serverId}/index.m3u8`;
}

export function isRepackPlaylistUrl(value: string) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return raw.includes("/live/m") && raw.includes("/s") && raw.endsWith("/index.m3u8");
}
