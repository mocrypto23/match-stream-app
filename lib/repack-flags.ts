import { getP2PEligibleServerIds, getRepackEligibleServerIds } from "./server-capabilities";

export type RepackFlags = {
  enabled: boolean;
  repackServers: Set<number>;
  p2pServers: Set<number>;
  publicBaseUrl: string;
};

function toBool(raw: string | undefined, fallback = false) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseServerSet(raw: string | undefined, fallback: number[]) {
  const parts = String(raw || "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return new Set<number>(parts.length ? parts : fallback);
}

function normalizePublicBaseUrl(raw: string | undefined) {
  const base = String(raw || "").trim() || "https://r2.tf-player.site/live";
  return base.replace(/\/+$/, "");
}

export function getRuntimeRepackFlags(env = process.env): RepackFlags {
  const repackDefaults = getRepackEligibleServerIds();
  const p2pDefaults = getP2PEligibleServerIds();
  const configuredP2P = String(env.P2P_SERVERS || "").trim() || String(env.NEXT_PUBLIC_P2P_SERVERS || "").trim();
  return {
    enabled: toBool(env.REPACK_ENABLED, false),
    repackServers: parseServerSet(env.REPACK_SERVERS, repackDefaults),
    p2pServers: parseServerSet(configuredP2P, p2pDefaults),
    publicBaseUrl: normalizePublicBaseUrl(env.REPACK_PUBLIC_BASE_URL || env.NEXT_PUBLIC_REPACK_PUBLIC_BASE_URL),
  };
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
