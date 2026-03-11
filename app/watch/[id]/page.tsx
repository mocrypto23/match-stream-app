"use client";

import Hls from "hls.js";
import Link from "next/link";
import VideoPlayerControls from "@/components/VideoPlayerControls";
import {
  getRuntimeRepackFlags,
  isRepackPlaylistUrl,
} from "@/lib/repack-flags";
import type { MatchR2Status, R2StatusServerEntry } from "@/lib/r2-status-types";
import { getServerCapability } from "@/lib/server-capabilities";
import { getSlotServerIdForUiServer, type UiServerId } from "@/lib/server-source-policy";
import { getClientStreamMode, isR2StrictMode, type StreamMode } from "@/lib/stream-mode";
import { computeMatchWindowState, getMatchWindowConfig, parseMatchStartMs } from "@/lib/match-window";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MatchRow = {
  id: number;
  match_key?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  home_logo?: string | null;
  away_logo?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
  stream_url_5?: string | null;
  stream_url_6?: string | null;
  match_start?: string | null;
  status_key?: string | null;
  stream_mode?: StreamMode;
  r2Status?: MatchR2Status | null;
  r2_status?: MatchR2Status | null;
  repack?: {
    enabled?: boolean;
    repackServers?: number[];
    p2pServers?: number[];
    publicBaseUrl?: string;
  } | null;
};

type ClientRepackFlags = {
  enabled: boolean;
  repackServers: Set<number>;
  p2pServers: Set<number>;
  publicBaseUrl: string;
};

type ServerOption = {
  n: number;
  label: string;
  url: string | null;
  fallbackUrl?: string | null;
  repackActive?: boolean;
  repackDecisionReason?: string;
  repackReadPct?: number;
  repackBucket?: number;
  sticky?: boolean;
};
type ServerHealthState = "ok" | "down" | "pending";
type StrictRecoveryState = "healthy" | "retrying" | "breaker_open";

const SERVER_SOURCE_LABELS: Record<number, string> = {
  1: "سيرفر 4 ",
  2: "سيرفر 2 ",
  3: "سيرفر 3 ",
  4: "سيرفر 1 ",
};
const SERVER_DISPLAY_ORDER = [4, 2, 3, 1, 5, 6] as const;
const VIEWER_SESSION_STORAGE_KEY = "tf_player_viewer_session";
type P2PProfile = "balanced" | "max-stability" | "low-latency";
type P2PEventName = "onPeerConnect" | "onPeerClose" | "onChunkDownloaded" | "onChunkUploaded" | "onSegmentError";
type P2PEngineInstance = {
  addEventListener: (eventName: P2PEventName, listener: (...args: unknown[]) => void) => void;
  removeEventListener: (eventName: P2PEventName, listener: (...args: unknown[]) => void) => void;
  getConfigForHlsJs: () => Record<string, unknown>;
  bindHls: (hls: Hls) => void;
  destroy: () => void;
};
type P2PEngineConstructor = new (config?: { core?: { swarmId?: string } }) => P2PEngineInstance;

const STALL_FREEZE_MS = 18000;
const P2P_STALL_FREEZE_MS = 30000;
const REPACK_STALE_PLAYLIST_MAX_IDLE_MS = 20_000;
const REPACK_STALE_PROGRESS_GUARD_MS = 14_000;
const REPACK_HLS_MAX_BUFFER_LENGTH = 18;
const REPACK_HLS_MAX_MAX_BUFFER_LENGTH = 30;
const REPACK_HLS_LIVE_SYNC_COUNT = 3;
const REPACK_HLS_LIVE_MAX_LATENCY_COUNT = 9;
const REPACK_HLS_WAITING_RECOVERY_MIN_STALL_MS = 5000;
const REPACK_HLS_WAITING_RECOVERY_MAX_BUFFER_AHEAD_S = 0.8;
const P2P_WAITING_RECOVERY_MIN_STALL_MS = 10000;
const P2P_WAITING_RECOVERY_MAX_BUFFER_AHEAD_S = 0.6;
const P2P_RECOVERY_THROTTLE_MS = 8000;
const PLAYER_LOADING_OVERLAY_DELAY_MS = 1200;
const DEFAULT_PLAYER_QUALITY_HEIGHT = 480;
// Keep auto-unmute opt-in only; auto audio toggling can trigger browser pause on some devices.
const AUTO_AUDIO_SYNC_ON_START = process.env.NEXT_PUBLIC_AUTO_AUDIO_SYNC_ON_START === "1";
const P2P_HLSJS_BROWSER_MODULE_URL = "https://esm.sh/p2p-media-loader-hlsjs@2.2.2?bundle&conditions=browser";
const ESM_SH_PROCESS_SHIM_URL = "https://esm.sh/node/process.mjs";
const P2P_FEATURE_FLAG = String(process.env.NEXT_PUBLIC_P2P_ENABLED || "").trim() === "1";
const REPACK_FLAGS = getRuntimeRepackFlags();
const STREAM_MODE = getClientStreamMode();
const R2_STRICT_MODE = isR2StrictMode(STREAM_MODE);
const MATCH_WINDOW_CONFIG = getMatchWindowConfig();
const P2P_PROFILE = (() => {
  const raw = String(process.env.NEXT_PUBLIC_P2P_PROFILE || "").trim().toLowerCase();
  if (raw === "max-stability") return "max-stability" as const;
  if (raw === "low-latency") return "low-latency" as const;
  return "balanced" as const;
})();
const AUTO_RECOVERY_SCHEDULE_MS = [5000, 10000, 20000, 30000] as const;
const STRICT_R2_BACKOFF_MS = [2000, 4000, 8000] as const;
const STRICT_R2_BREAKER_OPEN_MS = 25_000;
const STRICT_R2_READY_URL_GRACE_MS = 45_000;
const STRICT_BOOTSTRAP_RECENT_WINDOW_MS = 20_000;
const NETWORK_FATAL_WINDOW_MS = 12_000;
const RESOLVE_COOLDOWN_MS = 1500;
const REPACK_SEED_DEDUPE_WINDOW_MS = 12_000;
const REPACK_TOKEN_REFRESH_KICK_MS = 16_000;
const EMBED_FALLBACK_ENABLED = false;
const LIVE_ONLY_PLAYBACK = String(process.env.NEXT_PUBLIC_LIVE_ONLY_PLAYBACK || "1").trim() !== "0";
const CANDIDATE_PROBE_TIMEOUT_MS = 6500;
const FAST_PHASE_PROBE_TIMEOUT_MS = 2200;
const FAST_PHASE_MAX_PLAYER_PAGES = 5;
const FAST_PHASE_MAX_DEEP_CANDIDATES = 6;
const FAST_PHASE_MAX_PLAYERV2_POOL = 2;
const SERVER5_STAGE1_MAX_CHECKS = 4;
const SERVER5_STAGE1_TIMEOUT_MS = 2000;
const SERVER5_FAST_STAGE0_MAX_CHECKS = 4;
const SERVER5_FAST_STAGE0_TIMEOUT_MS = 1600;
const RESOLVE_CHILD_CONCURRENCY = 3;
const EXPAND_VARIANTS_CONCURRENCY = 4;
const PROBE_CONCURRENCY = 4;
const SERVER1_FETCH_TIMEOUT_FAST_MS = 7000;
const SERVER1_FETCH_TIMEOUT_FINAL_MS = 16000;
const SERVER1_PROBE_TIMEOUT_MS = 12000;
const SERVER1_FETCH_RETRIES = 1;
const SERVER1_FETCH_RETRY_DELAY_MS = 250;
const LIVEHD77_FETCH_TIMEOUT_FAST_MS = 4500; // Balanced: Fast enough for good net, allows some lag
const LIVEHD77_FETCH_TIMEOUT_FINAL_MS = 25000; // Increased for max reliability on slow net
const LIVEHD77_PROBE_TIMEOUT_MS = 15000; // Deep scraping needs time
const LIVEHD77_FETCH_RETRIES = 2;
const LIVEHD77_FETCH_RETRY_DELAY_MS = 220;
const SERVER3_STAGE0_MAX_CHECKS = 5;
const SERVER3_STAGE0_TIMEOUT_MS = 2200;
const SERVER3_STAGE0_MAX_CHILD_CHECKS = 1;
const SERVER4_FETCH_TIMEOUT_FAST_MS = 6500;
const SERVER4_FETCH_TIMEOUT_FINAL_MS = 16000;
const SERVER4_PROBE_TIMEOUT_MS = 12000;
const SERVER4_FETCH_RETRIES = 1;
const SERVER4_FETCH_RETRY_DELAY_MS = 220;
const RESOLVE_RESULT_CACHE_TTL_MS = 75_000;
const PLAYERV2_RESOLVE_CACHE_TTL_MS = 18_000;
const PLAYERV2_STICKY_CACHE_TTL_MS = 8 * 60_000;
const PLAYERV2_TOKEN_CACHE_TTL_MS = 20_000;
const PLAYERV2_TOKEN_STALE_FALLBACK_MS = 6_000;
const SERVER5_SIBLING_DISCOVERY_TTL_MS = 4 * 60_000;
const PLAYERV2_CACHE_MAX_CANDIDATES = 32;
const RESOLVE_RESULT_CACHE_MAX = 250;
const SERVER5_SIBLING_CACHE_MAX = 80;
const SERVER5_MATCH_PAGE_SCAN_LIMIT = 10;
const SERVER5_LANDING_LIMIT = 8;
const SERVER5_HLS_BACK_BUFFER_LENGTH = 70;
const SERVER5_HLS_MAX_BUFFER_LENGTH = 48;
const SERVER5_HLS_MAX_MAX_BUFFER_LENGTH = 100;
const SERVER5_HLS_LIVE_SYNC_COUNT = 4;
const SERVER5_HLS_LIVE_MAX_LATENCY_COUNT = 12;
const SERVER5_HLS_MANIFEST_RETRIES = 8;
const SERVER5_HLS_LEVEL_RETRIES = 8;
const SERVER5_HLS_FRAG_RETRIES = 10;
const SERVER3_DERIVE_CACHE_TTL_MS = 120_000;
const SERVER5_FAST_LANDING_LIMIT = 3;
const SERVER5_FINAL_LANDING_LIMIT = 4;
const SERVER5_FAST_CHANNEL_KEY_LIMIT = 2;
const SERVER5_FINAL_CHANNEL_KEY_LIMIT = 3;
const SERVER5_FAST_LOOKUP_ENDPOINT_LIMIT = 1;
const SERVER5_FINAL_LOOKUP_ENDPOINT_LIMIT = 2;
const SERVER5_FAST_MIN_RESOLVED_CANDIDATES = 2;
const SERVER5_RESOLVE_TOTAL_BUDGET_MS = 9_000;
const SERVER5_PREWARM_SYNC_WAIT_MS = 700;
const SERVER5_LOOKUP_TIMEOUT_FAST_MS = 1_200;
const SERVER5_LOOKUP_TIMEOUT_FINAL_MS = 2_200;
const SERVER5_FETCH_TIMEOUT_FINAL_MS = 3_000;
const SERVER5_PROBE_TIMEOUT_MS = 2_200;
const SERVER5_STAGE2_MAX_CHECKS = 8;
const SERVER5_STAGE2_TIMEOUT_MS = 2_000;
const SERVER5_STAGE2_MAX_CHECKS_WHEN_STAGE1_HIT = 3;
const SERVER5_FAST_FAILOVER_COOLDOWN_MS = 4_000;
const SERVER5_LOOKUP_SUCCESS_CACHE_TTL_MS = 5 * 60_000;
const SERVER5_LOOKUP_MISS_CACHE_TTL_MS = 90_000;
const SERVER5_HTML_FETCH_CACHE_TTL_MS = 150_000;
const SERVER5_HTML_FETCH_MISS_TTL_MS = 90_000;
const SERVER5_HTML_FETCH_CACHE_MAX = 260;
const SERVER5_PREWARM_CACHE_TTL_MS = 90_000;
const SERVER5_REFRESH_RUNTIME_CACHE_TTL_MS = 90_000;
const SERVER5_PROBE_SUCCESS_CACHE_TTL_MS = 75_000;
const SERVER5_PROBE_MISS_CACHE_TTL_MS = 20_000;
const SERVER5_PROBE_CACHE_MAX = 800;
const SERVER5_PREWARM_WARM_TIMEOUT_MS = 3_000;
const SERVER5_PREWARM_WARM_PROBE_TIMEOUT_MS = 1_700;
const SERVER5_PREWARM_WARM_MAX_CHECKS = 2;
const SERVER5_FINAL_ERROR_MIN_MS = 20_000;
const NO_STREAM_SELECTED_SERVER_MESSAGE = "لا يوجد بث في هذا السيرفر لهذه المباراة";
const HLS_CT = ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"];
const MEDIA_RE = /\.(?:m3u8|mp4|m4v|mov|webm|mpd|ts)(?:[?#]|$)/i;
const SEGMENT_FILE_RE = /\.(?:ts|m4s|m4f|cmf|mp4|aac|ac3|ec3|mp3|vtt|webm|key)(?:[?#]|$)/i;
const PLAYLIST_HINT_RE = /\.(?:m3u8)(?:[?#]|$)|\/(?:master|index|playlist|manifest)\b/i;
const NON_STREAM_EXT_RE =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|woff2?|ttf|eot|otf|map|json|xml|txt|pdf)(?:[?#]|$)/i;
const NON_STREAM_HOST_HINTS = [
  "wp.com",
  "i0.wp.com",
  "gravatar.com",
  "schema.org",
  "facebook.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "google.com",
  "googlesyndication.com",
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
];
const NON_STREAM_PATH_HINTS = [
  "/wp-content/uploads/",
  "/comments/feed",
  "/feed/",
  "/category/",
  "/tag/",
  "/author/",
  "/matches/",
  "/favicon",
  "/logo",
  "/static/",
  "/images/",
];
const STREAM_STRONG_HINTS = [
  ".m3u8",
  "/hls/",
  "/live/",
  "playlist",
  "chunks",
  "master.m3u8",
  "index.m3u8",
  "manifest",
  "nimblesessionid",
  "token=",
  "sid=",
];
const PLAYER_PAGE_HINT_RE = /\/albaplayer\/|\/alba\.php|\/playerv2\.php|\/embed\b|\/player\b|\/tv\/|\/chtv\/|\/ch\d+\.php(?:[?#]|$)/i;
const PLAYERV2_CONFIG_RE = /window\.tabsConfig\s*=\s*(\{[\s\S]*?\});/i;

const PLAYERV2_FALLBACK_DOMAINS = [
  "https://1rxolmirvosixpyfy.yallashot.us/",
  "https://jqyjghfms1mu8zc.yallashot.us/",
];
const YALLASHOOT_DIRECT_HLS_FALLBACK_DOMAINS = [
  "yallashootttv.com",
  "yallashoot.cv",
  "yallashoooootlive.online",
] as const;
const SERVER5_STACK_HOST_HINTS = [
  "anewssport.fun",
  "yallalive.sx",
  "zxxxeeplay.fun",
  "codepcplay.fun",
  "playerai.site",
  "dvalna.ru",
  "soyspace.cyou",
  "coopnnn.fun",
] as const;
const SERVER5_LOOKUP_ENDPOINT_FALLBACKS = [
  "https://chevy.soyspace.cyou/server_lookup",
  "https://chevy.dvalna.ru/server_lookup",
] as const;
const SERVER5_STARTUP_NO_FRAME_TIMEOUT_MS = 5_500;
const SERVER5_STARTUP_NO_FRAME_RECHECK_MS = 1_500;
const SERVER3_AUTOSWITCH_WINDOW_MS = 20_000;
const SERVER3_AUTOSWITCH_LIMIT = 3;

function getP2PProfileHlsTuning(profile: P2PProfile) {
  if (profile === "max-stability") {
    return {
      liveSyncDurationCount: 7,
      liveMaxLatencyDurationCount: 20,
      maxBufferLength: 75,
      maxBufferSize: 40 * 1000 * 1000,
    };
  }
  if (profile === "low-latency") {
    return {
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 12,
      maxBufferLength: 45,
      maxBufferSize: 20 * 1000 * 1000,
    };
  }
  return {
    liveSyncDurationCount: 6,
    liveMaxLatencyDurationCount: 18,
    maxBufferLength: 60,
    maxBufferSize: 30 * 1000 * 1000,
  };
}

type Playerv2TokenPayload = { token: string; session_id: string };
type AlbaRollingConfig = { ch: string; dm: string[]; iv: number };
type ProbeHlsOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxChildChecks?: number;
  pushDiag?: (line: string) => void;
};
type FilterPlayableOptions = ProbeHlsOptions & { maxChecks?: number; concurrency?: number };
type ResolveBatchPhase = "fast" | "deep" | "token";
type Server3RootServ = 0 | 1 | null;
type Server3CandidateProvenance = {
  rootPathKey: string;
  rootServ: Server3RootServ;
  originStage: ResolveBatchPhase;
};
type Server3DeriveState = "idle" | "loading" | "ready" | "empty" | "error";
type ResolveCandidatesResult = {
  candidates: string[];
  provenanceByKey: Map<string, Server3CandidateProvenance>;
};
type ResolveResultCacheEntry = { expiresAt: number; candidates: string[] };
type Playerv2StickyCacheEntry = { expiresAt: number; candidates: string[] };
type Playerv2TokenCacheEntry = { expiresAt: number; tokenPayload: Playerv2TokenPayload };
type Server5SiblingDiscoveryCacheEntry = { expiresAt: number; urls: string[] };
type Server3DeriveCacheEntry = {
  expiresAt: number;
  url: string | null;
  state: Exclude<Server3DeriveState, "idle" | "loading">;
};
type Server5LookupCacheEntry = { expiresAt: number; serverKey: string | null };
type Server5HtmlFetchCacheEntry = { expiresAt: number; ok: boolean; ct: string; html: string };
type Server5PrewarmCacheEntry = { expiresAt: number; candidates: string[] };
type Server5RuntimeRefreshCacheEntry = { expiresAt: number; url: string | null; status: "hit" | "miss" | "skip" };
type Server5ProbeCacheEntry = { expiresAt: number; ok: boolean };
type Server5AuthContext = { authToken: string; channelKey: string; channelSalt: string };
type CandidateGroup = { key: string; primaryIndex: number; members: number[]; label: string };

const resolveResultCache = new Map<string, ResolveResultCacheEntry>();
const playerv2StickyCache = new Map<string, Playerv2StickyCacheEntry>();
const playerv2TokenCache = new Map<string, Playerv2TokenCacheEntry>();
const server5SiblingDiscoveryCache = new Map<string, Server5SiblingDiscoveryCacheEntry>();
const server3DeriveCache = new Map<string, Server3DeriveCacheEntry>();
const server5LookupCache = new Map<string, Server5LookupCacheEntry>();
const server5LookupInFlight = new Map<string, Promise<string | null>>();
const server5HtmlFetchCache = new Map<string, Server5HtmlFetchCacheEntry>();
const server5PrewarmCache = new Map<string, Server5PrewarmCacheEntry>();
const server5RuntimeRefreshCache = new Map<string, Server5RuntimeRefreshCacheEntry>();
const server5ProbeCache = new Map<string, Server5ProbeCacheEntry>();
const server5ProbeInFlight = new Map<string, Promise<boolean>>();

function resolveResultCacheKey(sourceUrl: string) {
  return canonicalizeUrl(sourceUrl) || String(sourceUrl || "").trim().toLowerCase();
}

function trimResolveResultCache(now = Date.now()) {
  for (const [key, value] of resolveResultCache.entries()) {
    if (value.expiresAt <= now) resolveResultCache.delete(key);
  }
  if (resolveResultCache.size <= RESOLVE_RESULT_CACHE_MAX) return;
  while (resolveResultCache.size > RESOLVE_RESULT_CACHE_MAX) {
    const firstKey = resolveResultCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    resolveResultCache.delete(firstKey);
  }
}

function getCachedResolveCandidates(sourceUrl: string) {
  const key = resolveResultCacheKey(sourceUrl);
  const now = Date.now();
  const cached = resolveResultCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) resolveResultCache.delete(key);
    return [] as string[];
  }
  return [...cached.candidates];
}

function setCachedResolveCandidates(sourceUrl: string, candidates: string[]) {
  const base = dedupeUrls((candidates || []).filter((x) => !!x));
  const cleaned = isPlayerv2LikeUrl(sourceUrl) ? compactPlayerv2Candidates(base) : base;
  if (!cleaned.length) return;
  const now = Date.now();
  const ttlMs = isPlayerv2LikeUrl(sourceUrl) ? PLAYERV2_RESOLVE_CACHE_TTL_MS : RESOLVE_RESULT_CACHE_TTL_MS;
  resolveResultCache.set(resolveResultCacheKey(sourceUrl), {
    expiresAt: now + ttlMs,
    candidates: cleaned,
  });
  trimResolveResultCache(now);
}

function clearCachedResolveCandidates(sourceUrl: string) {
  resolveResultCache.delete(resolveResultCacheKey(sourceUrl));
}

function buildServer3DeriveCacheKey(homeTeam?: string | null, awayTeam?: string | null) {
  const home = normalizeTeamNameForMatchCompare(homeTeam);
  const away = normalizeTeamNameForMatchCompare(awayTeam);
  if (!home && !away) return "";
  return `${home}|${away}`;
}

function getServer3DeriveCacheEntry(cacheKey: string) {
  const key = String(cacheKey || "").trim();
  if (!key) return null as Server3DeriveCacheEntry | null;
  const now = Date.now();
  const cached = server3DeriveCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) server3DeriveCache.delete(key);
    return null;
  }
  return cached;
}

function setServer3DeriveCacheEntry(
  cacheKey: string,
  value: { url: string | null; state: Exclude<Server3DeriveState, "idle" | "loading"> }
) {
  const key = String(cacheKey || "").trim();
  if (!key) return;
  const now = Date.now();
  server3DeriveCache.set(key, {
    expiresAt: now + SERVER3_DERIVE_CACHE_TTL_MS,
    url: value.url,
    state: value.state,
  });
  if (server3DeriveCache.size > 300) {
    for (const [cacheEntryKey, cacheEntryValue] of server3DeriveCache.entries()) {
      if (cacheEntryValue.expiresAt <= now) server3DeriveCache.delete(cacheEntryKey);
    }
    while (server3DeriveCache.size > 220) {
      const firstKey = server3DeriveCache.keys().next().value as string | undefined;
      if (!firstKey) break;
      server3DeriveCache.delete(firstKey);
    }
  }
}

function trimServer5LookupCache(now = Date.now()) {
  for (const [key, value] of server5LookupCache.entries()) {
    if (value.expiresAt <= now) server5LookupCache.delete(key);
  }
  if (server5LookupCache.size <= 600) return;
  while (server5LookupCache.size > 450) {
    const firstKey = server5LookupCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5LookupCache.delete(firstKey);
  }
}

function getServer5LookupCacheEntry(cacheKey: string) {
  const key = String(cacheKey || "").trim().toLowerCase();
  if (!key) return undefined as string | null | undefined;
  const now = Date.now();
  const cached = server5LookupCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) server5LookupCache.delete(key);
    return undefined;
  }
  return cached.serverKey;
}

function setServer5LookupCacheEntry(cacheKey: string, serverKey: string | null, ttlMs: number) {
  const key = String(cacheKey || "").trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  server5LookupCache.set(key, {
    expiresAt: now + Math.max(1000, ttlMs),
    serverKey: serverKey || null,
  });
  trimServer5LookupCache(now);
}

function buildServer5LookupCacheKey(landingId: string, channelKey: string, lookupEndpointUrl?: string | null) {
  const landing = sanitizeServer5ChannelKey(landingId).toLowerCase();
  const channel = sanitizeServer5ChannelKey(channelKey).toLowerCase();
  if (!channel) return "";
  let endpointKey = "default";
  const endpointRaw = String(lookupEndpointUrl || "").trim();
  if (endpointRaw) {
    try {
      const endpoint = new URL(endpointRaw);
      endpointKey = `${endpoint.hostname}${endpoint.pathname}`.toLowerCase();
    } catch {
      endpointKey = endpointRaw.toLowerCase().replace(/[^a-z0-9/_-]+/g, "");
    }
  }
  return `${endpointKey}|${landing || "none"}|${channel}`;
}

function trimServer5HtmlFetchCache(now = Date.now()) {
  for (const [key, value] of server5HtmlFetchCache.entries()) {
    if (value.expiresAt <= now) server5HtmlFetchCache.delete(key);
  }
  if (server5HtmlFetchCache.size <= SERVER5_HTML_FETCH_CACHE_MAX) return;
  while (server5HtmlFetchCache.size > Math.max(120, SERVER5_HTML_FETCH_CACHE_MAX - 80)) {
    const firstKey = server5HtmlFetchCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5HtmlFetchCache.delete(firstKey);
  }
}

function getServer5HtmlFetchCacheEntry(cacheKey: string) {
  const key = String(cacheKey || "").trim().toLowerCase();
  if (!key) return undefined as Server5HtmlFetchCacheEntry | undefined;
  const now = Date.now();
  const cached = server5HtmlFetchCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) server5HtmlFetchCache.delete(key);
    return undefined;
  }
  return cached;
}

function setServer5HtmlFetchCacheEntry(cacheKey: string, value: { ok: boolean; ct: string; html: string }) {
  const key = String(cacheKey || "").trim().toLowerCase();
  if (!key) return;
  const ttl = value.ok ? SERVER5_HTML_FETCH_CACHE_TTL_MS : SERVER5_HTML_FETCH_MISS_TTL_MS;
  const now = Date.now();
  server5HtmlFetchCache.set(key, {
    expiresAt: now + ttl,
    ok: !!value.ok,
    ct: String(value.ct || ""),
    html: String(value.html || ""),
  });
  trimServer5HtmlFetchCache(now);
}

function trimServer5PrewarmCache(now = Date.now()) {
  for (const [key, value] of server5PrewarmCache.entries()) {
    if (value.expiresAt <= now || !value.candidates.length) server5PrewarmCache.delete(key);
  }
  if (server5PrewarmCache.size <= 180) return;
  while (server5PrewarmCache.size > 120) {
    const firstKey = server5PrewarmCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5PrewarmCache.delete(firstKey);
  }
}

function getServer5PrewarmCandidates(sourceUrl: string) {
  const key = canonicalizeUrl(sourceUrl) || String(sourceUrl || "").trim().toLowerCase();
  if (!key) return [] as string[];
  const now = Date.now();
  const cached = server5PrewarmCache.get(key);
  if (!cached || cached.expiresAt <= now || !cached.candidates.length) {
    if (cached) server5PrewarmCache.delete(key);
    return [] as string[];
  }
  return [...cached.candidates];
}

function setServer5PrewarmCandidates(sourceUrl: string, candidates: string[]) {
  const key = canonicalizeUrl(sourceUrl) || String(sourceUrl || "").trim().toLowerCase();
  if (!key) return;
  const cleaned = prioritizeServer5Candidates(
    dedupeUrls(candidates || []).filter((candidate) => isServer5AuthReadyCandidate(candidate))
  ).slice(0, 16);
  if (!cleaned.length) return;
  const now = Date.now();
  server5PrewarmCache.set(key, {
    expiresAt: now + SERVER5_PREWARM_CACHE_TTL_MS,
    candidates: cleaned,
  });
  trimServer5PrewarmCache(now);
}

function server5RuntimeRefreshCacheKey(matchId: number | null, sourceUrl?: string | null) {
  const idPart = Number.isFinite(matchId || NaN) && (matchId || 0) > 0 ? String(matchId) : "0";
  const urlPart = canonicalizeUrl(String(sourceUrl || "").trim()) || "";
  return `${idPart}|${urlPart}`;
}

function trimServer5RuntimeRefreshCache(now = Date.now()) {
  for (const [key, value] of server5RuntimeRefreshCache.entries()) {
    if (value.expiresAt <= now) server5RuntimeRefreshCache.delete(key);
  }
  if (server5RuntimeRefreshCache.size <= 300) return;
  while (server5RuntimeRefreshCache.size > 220) {
    const firstKey = server5RuntimeRefreshCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5RuntimeRefreshCache.delete(firstKey);
  }
}

function getServer5RuntimeRefreshCached(matchId: number | null, sourceUrl?: string | null) {
  const key = server5RuntimeRefreshCacheKey(matchId, sourceUrl);
  const now = Date.now();
  const cached = server5RuntimeRefreshCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) server5RuntimeRefreshCache.delete(key);
    return null as Server5RuntimeRefreshCacheEntry | null;
  }
  return cached;
}

function setServer5RuntimeRefreshCached(
  matchId: number | null,
  sourceUrl: string | null | undefined,
  value: { url: string | null; status: "hit" | "miss" | "skip" }
) {
  const key = server5RuntimeRefreshCacheKey(matchId, sourceUrl);
  const now = Date.now();
  server5RuntimeRefreshCache.set(key, {
    expiresAt: now + SERVER5_REFRESH_RUNTIME_CACHE_TTL_MS,
    url: value.url && isValidHttpUrl(value.url) ? value.url : null,
    status: value.status,
  });
  trimServer5RuntimeRefreshCache(now);
}

function normalizeServer5ProbeTarget(candidateUrl: string) {
  const target = toUnderlyingUrl(String(candidateUrl || "").trim());
  if (!target || !isValidHttpUrl(target)) return "";
  try {
    const u = new URL(target);
    u.hash = "";
    const volatileKeys = ["ts", "t", "_", "cb", "cache", "v", "r", "rnd", "s5_fp_ts"];
    for (const key of volatileKeys) u.searchParams.delete(key);
    return u.toString().toLowerCase();
  } catch {
    return canonicalizeUrl(target) || target.toLowerCase();
  }
}

function buildServer5ProbeCacheKey(candidateUrl: string) {
  const canonical = normalizeServer5ProbeTarget(candidateUrl) || canonicalizeUrl(candidateUrl) || String(candidateUrl || "").trim().toLowerCase();
  if (!canonical) return "";
  const auth = extractServer5AuthContextFromProxyCandidate(candidateUrl);
  if (!auth) return canonical;
  return `${canonical}|${auth.channelKey.toLowerCase()}|${auth.channelSalt.toLowerCase()}`;
}

function trimServer5ProbeCache(now = Date.now()) {
  for (const [key, value] of server5ProbeCache.entries()) {
    if (value.expiresAt <= now) server5ProbeCache.delete(key);
  }
  if (server5ProbeCache.size <= SERVER5_PROBE_CACHE_MAX) return;
  while (server5ProbeCache.size > Math.max(620, SERVER5_PROBE_CACHE_MAX - 120)) {
    const firstKey = server5ProbeCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5ProbeCache.delete(firstKey);
  }
}

function getServer5ProbeCached(cacheKey: string) {
  const key = String(cacheKey || "").trim();
  if (!key) return null as boolean | null;
  const now = Date.now();
  const cached = server5ProbeCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) server5ProbeCache.delete(key);
    return null;
  }
  return !!cached.ok;
}

function setServer5ProbeCached(cacheKey: string, ok: boolean) {
  const key = String(cacheKey || "").trim();
  if (!key) return;
  const now = Date.now();
  const ttl = ok ? SERVER5_PROBE_SUCCESS_CACHE_TTL_MS : SERVER5_PROBE_MISS_CACHE_TTL_MS;
  server5ProbeCache.set(key, {
    expiresAt: now + ttl,
    ok: !!ok,
  });
  trimServer5ProbeCache(now);
}

function trimServer5SiblingDiscoveryCache(now = Date.now()) {
  for (const [key, value] of server5SiblingDiscoveryCache.entries()) {
    if (value.expiresAt <= now) server5SiblingDiscoveryCache.delete(key);
  }
  if (server5SiblingDiscoveryCache.size <= SERVER5_SIBLING_CACHE_MAX) return;
  while (server5SiblingDiscoveryCache.size > SERVER5_SIBLING_CACHE_MAX) {
    const firstKey = server5SiblingDiscoveryCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5SiblingDiscoveryCache.delete(firstKey);
  }
}

function playerv2CandidateFamilyKey(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const target = raw.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(raw) || "" : raw;
  const normalized = target || raw;
  if (!isValidHttpUrl(normalized)) {
    return canonicalizeUrl(raw) || raw.toLowerCase();
  }

  try {
    const u = new URL(normalized);
    u.hash = "";
    u.searchParams.delete("ts");
    u.searchParams.delete("nonce");
    u.searchParams.delete("token");
    u.searchParams.delete("sid");

    const sorted = Array.from(u.searchParams.entries()).sort(([ak, av], [bk, bv]) => {
      if (ak !== bk) return ak.localeCompare(bk);
      return av.localeCompare(bv);
    });
    const stable = new URLSearchParams();
    for (const [k, v] of sorted) stable.append(k, v);
    const q = stable.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`.toLowerCase();
  } catch {
    return canonicalizeUrl(raw) || raw.toLowerCase();
  }
}

function compactPlayerv2Candidates(input: string[], max = PLAYERV2_CACHE_MAX_CANDIDATES) {
  const list = dedupeUrls((input || []).filter((x) => !!x));
  if (!list.length) return [] as string[];

  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    const key = playerv2CandidateFamilyKey(item) || (canonicalizeUrl(item) || item).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }

  return out.reverse();
}

function playerv2StickyCacheKey(sourceUrl: string) {
  return canonicalizeUrl(sourceUrl) || String(sourceUrl || "").trim().toLowerCase();
}

function trimPlayerv2StickyCache(now = Date.now()) {
  for (const [key, value] of playerv2StickyCache.entries()) {
    if (value.expiresAt <= now || !value.candidates.length) playerv2StickyCache.delete(key);
  }
}

function getPlayerv2StickyCandidates(sourceUrl: string) {
  const key = playerv2StickyCacheKey(sourceUrl);
  const now = Date.now();
  const cached = playerv2StickyCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) playerv2StickyCache.delete(key);
    return [] as string[];
  }
  return [...cached.candidates];
}

function setPlayerv2StickyCandidates(sourceUrl: string, candidates: string[]) {
  const cleaned = compactPlayerv2Candidates(candidates || []);
  if (!cleaned.length) return;
  const now = Date.now();
  playerv2StickyCache.set(playerv2StickyCacheKey(sourceUrl), {
    expiresAt: now + PLAYERV2_STICKY_CACHE_TTL_MS,
    candidates: cleaned,
  });
  trimPlayerv2StickyCache(now);
}

function playerv2TokenCacheKey(playerv2Url: string, tokenPath: string) {
  const page = canonicalizeUrl(playerv2Url) || String(playerv2Url || "").trim().toLowerCase();
  const path = normalizePlayerv2Path(tokenPath) || String(tokenPath || "").trim();
  return `${page}|${path}`;
}

function trimPlayerv2TokenCache(now = Date.now()) {
  for (const [key, value] of playerv2TokenCache.entries()) {
    if (value.expiresAt + PLAYERV2_TOKEN_STALE_FALLBACK_MS <= now) playerv2TokenCache.delete(key);
  }
}

function getCachedPlayerv2Token(playerv2Url: string, tokenPath: string, allowStale = false) {
  const key = playerv2TokenCacheKey(playerv2Url, tokenPath);
  const now = Date.now();
  const cached = playerv2TokenCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt > now) return cached.tokenPayload;
  if (allowStale && cached.expiresAt + PLAYERV2_TOKEN_STALE_FALLBACK_MS > now) return cached.tokenPayload;
  playerv2TokenCache.delete(key);
  return null;
}

function setCachedPlayerv2Token(playerv2Url: string, tokenPath: string, payload: Playerv2TokenPayload) {
  const token = String(payload?.token || "").trim();
  const sessionId = String(payload?.session_id || "").trim();
  if (!token || !sessionId) return;
  const now = Date.now();
  playerv2TokenCache.set(playerv2TokenCacheKey(playerv2Url, tokenPath), {
    expiresAt: now + PLAYERV2_TOKEN_CACHE_TTL_MS,
    tokenPayload: { token, session_id: sessionId },
  });
  trimPlayerv2TokenCache(now);
}

function isValidHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isKnownServer5MonoCssManifestUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw || !isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isServer5MonoHost =
      host === "dvalna.ru" ||
      host.endsWith(".dvalna.ru") ||
      host === "soyspace.cyou" ||
      host.endsWith(".soyspace.cyou") ||
      host === "coopnnn.fun" ||
      host.endsWith(".coopnnn.fun");
    if (!isServer5MonoHost) return false;
    return /\/[a-z0-9/_-]+\/[a-z0-9_-]+\/mono\.css$/i.test(path);
  } catch {
    return false;
  }
}

function isKnownServer5ProxyManifestUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw || !isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (!isServer5StackHost(host)) return false;
    return /\/proxy\/[a-z0-9/_-]+\/[a-z0-9_-]+\/mono\.(?:m3u8|css)$/i.test(path);
  } catch {
    return false;
  }
}

function isServer5StackHost(hostname?: string | null) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return false;
  return SERVER5_STACK_HOST_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`));
}

function isServer5StackCandidate(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const target = raw.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(raw) || "" : toUnderlyingUrl(raw);
  if (!target || !isValidHttpUrl(target)) return false;
  try {
    const host = new URL(target).hostname.toLowerCase();
    return isServer5StackHost(host);
  } catch {
    return false;
  }
}

function isServer5AuthReadyCandidate(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw || !raw.startsWith("/api/embed-proxy?")) return false;
  if (!isServer5StackCandidate(raw)) return false;
  if (extractServer5AuthContextFromProxyCandidate(raw)) return true;
  return isKnownServer5ProxyManifestUrl(raw);
}

function getServer5CandidateIdentity(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const target = raw.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(raw) || "" : toUnderlyingUrl(raw);
  if (!target || !isValidHttpUrl(target)) return "";
  try {
    let slot = "";
    if (raw.startsWith("/api/embed-proxy?")) {
      try {
        slot = String(new URL(raw, "http://localhost").searchParams.get("s5_slot") || "").trim();
      } catch { }
    }
    const u = new URL(target);
    if (!slot) slot = String(u.searchParams.get("s5_slot") || "").trim();
    const slotPart = slot ? `|slot:${slot}` : "";
    const host = u.hostname.toLowerCase();
    if (!isServer5StackHost(host)) return "";
    const path = u.pathname.toLowerCase();
    const proxyMono = path.match(/\/proxy\/([a-z0-9/_-]+)\/([a-z0-9_-]+)\/mono\.(?:m3u8|css)$/i);
    if (proxyMono) {
      return `${host}|proxy|${String(proxyMono[1] || "").toLowerCase()}|${String(proxyMono[2] || "").toLowerCase()}${slotPart}`;
    }
    const legacyMono = path.match(/\/([a-z0-9/_-]+)\/([a-z0-9_-]+)\/mono\.css$/i);
    if (legacyMono) {
      return `${host}|legacy|${String(legacyMono[1] || "").toLowerCase()}|${String(legacyMono[2] || "").toLowerCase()}${slotPart}`;
    }
    return `${canonicalizeUrl(target) || target.toLowerCase()}${slotPart}`;
  } catch {
    return "";
  }
}

function scoreServer5CandidatePreference(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const target = raw.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(raw) || "" : toUnderlyingUrl(raw);
  if (!target || !isValidHttpUrl(target)) return 0;
  try {
    let slot = "";
    if (raw.startsWith("/api/embed-proxy?")) {
      try {
        slot = String(new URL(raw, "http://localhost").searchParams.get("s5_slot") || "").trim();
      } catch { }
    }
    const u = new URL(target);
    if (!slot) slot = String(u.searchParams.get("s5_slot") || "").trim();
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    let score = 0;
    if (slot === "2") score += 10;
    else if (slot === "1") score += 7;
    else if (slot === "3") score += 5;
    else if (slot === "4") score += 4;
    if (/\/mono\.m3u8(?:[?#]|$)/i.test(path)) score += 4;
    else if (/\/mono\.css(?:[?#]|$)/i.test(path)) score += 2;
    if (host === "soyspace.cyou" || host.endsWith(".soyspace.cyou")) score += 2;
    if (host === "dvalna.ru" || host.endsWith(".dvalna.ru")) score += 1;
    const auth = extractServer5AuthContextFromProxyCandidate(raw);
    if (auth) {
      score += 16;
      if (auth.channelKey.toLowerCase().startsWith("yallalive")) score += 8;
    } else if (raw.startsWith("/api/embed-proxy?")) {
      score -= 5;
    }
    return score;
  } catch {
    return 0;
  }
}

function collapseServer5EquivalentCandidates(values: string[]) {
  const out = new Map<string, string>();
  for (const value of dedupeUrls(values)) {
    const id = getServer5CandidateIdentity(value) || (canonicalizeUrl(value) || value.toLowerCase());
    const existing = out.get(id);
    if (!existing) {
      out.set(id, value);
      continue;
    }
    if (scoreServer5CandidatePreference(value) > scoreServer5CandidatePreference(existing)) {
      out.set(id, value);
    }
  }
  return Array.from(out.values());
}

function prioritizeServer5Candidates(values: string[]) {
  const collapsed = collapseServer5EquivalentCandidates(values);
  return collapsed
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreServer5CandidatePreference(candidate),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

function isClearlyNonStreamUrl(value?: string | null) {
  const v = String(value || "").trim();
  if (!v || !isValidHttpUrl(v)) return true;
  if (isKnownServer5MonoCssManifestUrl(v) || isKnownServer5ProxyManifestUrl(v)) return false;
  try {
    const u = new URL(v);
    const host = u.hostname.toLowerCase();
    const hay = `${u.pathname}${u.search}`.toLowerCase();
    if (NON_STREAM_EXT_RE.test(hay)) return true;
    if (NON_STREAM_HOST_HINTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    if (NON_STREAM_PATH_HINTS.some((h) => hay.includes(h))) return true;
    return false;
  } catch {
    return true;
  }
}

function isStrongPlayableStreamUrl(value?: string | null) {
  const v = String(value || "").trim();
  if (!v || !isValidHttpUrl(v)) return false;
  if (isKnownServer5MonoCssManifestUrl(v) || isKnownServer5ProxyManifestUrl(v)) return true;
  if (isClearlyNonStreamUrl(v)) return false;
  try {
    const u = new URL(v);
    const hay = `${u.pathname}${u.search}`.toLowerCase();
    if (MEDIA_RE.test(hay) && !NON_STREAM_EXT_RE.test(hay)) return true;
    return STREAM_STRONG_HINTS.some((h) => hay.includes(h));
  } catch {
    return false;
  }
}

function getProxyTargetUrl(value: string) {
  const v = String(value || "").trim();
  if (!v.startsWith("/api/embed-proxy?")) return null;
  try {
    const u = new URL(v, "http://localhost");
    const raw = u.searchParams.get("url");
    if (!raw) return null;
    return normalizeURIComponent(raw);
  } catch {
    return null;
  }
}

function normalizeURIComponent(raw: string) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function canonicalizeUrl(value: string) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (v.startsWith("/api/embed-proxy?")) {
    const target = getProxyTargetUrl(v);
    return target ? `proxy:${target.toLowerCase()}` : `proxy:${v.toLowerCase()}`;
  }
  if (!isValidHttpUrl(v)) return null;
  try {
    const u = new URL(v);
    u.hash = "";
    return u.toString().toLowerCase();
  } catch {
    return v.toLowerCase();
  }
}

function parseServerIdSetFromUnknown(raw: unknown, fallback: Set<number>) {
  const out = new Set<number>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = Number.parseInt(String(item ?? "").trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) out.add(parsed);
    }
  } else if (typeof raw === "string") {
    for (const token of raw.split(",")) {
      const parsed = Number.parseInt(String(token || "").trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) out.add(parsed);
    }
  }
  return out.size ? out : fallback;
}

function buildClientRepackFlags(matchRepack: MatchRow["repack"]): ClientRepackFlags {
  const fallback = REPACK_FLAGS;
  const enabled = typeof matchRepack?.enabled === "boolean" ? matchRepack.enabled : fallback.enabled;
  return {
    enabled,
    repackServers: parseServerIdSetFromUnknown(matchRepack?.repackServers, fallback.repackServers),
    p2pServers: parseServerIdSetFromUnknown(matchRepack?.p2pServers, fallback.p2pServers),
    publicBaseUrl:
      String(matchRepack?.publicBaseUrl || "").trim().replace(/\/+$/, "") || fallback.publicBaseUrl,
  };
}

function getOrCreateViewerSessionId() {
  if (typeof window === "undefined") return "anon";
  try {
    const existing = String(window.localStorage.getItem(VIEWER_SESSION_STORAGE_KEY) || "").trim();
    if (existing) return existing;
    const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(VIEWER_SESSION_STORAGE_KEY, generated);
    return generated;
  } catch {
    return "anon";
  }
}

function toUnderlyingUrl(value: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!v.startsWith("/api/embed-proxy?")) return v;
  return getProxyTargetUrl(v) || v;
}

function isSafeToCacheUrl(value?: string | null) {
  const v = String(value || "").trim();
  if (!v || !isValidHttpUrl(v)) return false;

  // 1. Length Check: Huge URLs are often tokenized blobs
  if (v.length > 450) return false;

  // 2. Token Keyword Check: Common params for expiration/auth
  const lower = v.toLowerCase();
  if (
    lower.includes("token=") ||
    lower.includes("?st=") ||
    lower.includes("&st=") ||
    lower.includes("?e=") ||
    lower.includes("&e=") ||
    lower.includes("expires=") ||
    lower.includes("signature=") ||
    lower.includes("?t=") || // Often timestamp
    lower.includes("&t=")
  ) {
    return false;
  }

  // 3. Pattern Check: Looks like a segmented session path?
  // e.g. /session/12345/index.m3u8
  if (/\/session\/|\/auth\//i.test(lower)) return false;

  return true;
}

function isServer2HardWrapperLikeUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw || !isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const hostAllowed =
      host === "yallashot.us" ||
      host.endsWith(".yallashot.us") ||
      host === "aleynoxitram.sbs" ||
      host.endsWith(".aleynoxitram.sbs") ||
      host === "siiir.tv" ||
      host.endsWith(".siiir.tv");
    if (!hostAllowed) return false;
    if (!/\/hard\/[^/?#]+\.html$/i.test(path)) return false;
    const matchId = String(u.searchParams.get("match") || "").trim().toLowerCase().replace(/^match/, "");
    return /^\d{1,6}$/.test(matchId);
  } catch {
    return false;
  }
}

function isSiiirHost(value?: string | null) {
  const raw = String(value || "").trim();
  if (!isValidHttpUrl(raw)) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "siiir.tv" || host.endsWith(".siiir.tv");
  } catch {
    return false;
  }
}

function isServer2SiiirRelatedCandidate(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const target = toUnderlyingUrl(raw);
  if (isSiiirHost(target)) return true;
  const ref = getProxyRefUrlFromCandidate(raw);
  if (ref && isSiiirHost(ref)) return true;
  return false;
}

function isPlayerv2LikeUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  return (
    /\/playerv2\.php(?:\?|$)/i.test(raw) ||
    /[?&]action=generate_token(?:&|$)/i.test(raw) ||
    isServer2HardWrapperLikeUrl(raw)
  );
}

function isLivehd77LikeUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw || !isValidHttpUrl(raw)) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "livehd77.pro" || host.endsWith(".livehd77.pro");
  } catch {
    return false;
  }
}

function isPlayerv2TokenEndpointUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw) return false;
  return /\/playerv2\.php(?:\?|$)/i.test(raw) && /[?&]action=generate_token(?:&|$)/i.test(raw);
}

function normalizeQualityTag(raw?: string | null) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (/^\d{3,4}p$/.test(v)) return v;
  if (v === "sd") return "480p";
  if (v === "hd") return "720p";
  if (v === "fhd") return "1080p";
  if (v === "uhd" || v === "4k" || v === "2160p") return "2160p";
  return null;
}

function extractQualityTagFromUrl(value: string) {
  const raw = toUnderlyingUrl(value);
  if (!isValidHttpUrl(raw)) return null;
  try {
    const u = new URL(raw);
    const pathname = u.pathname.toLowerCase();

    const pathMatch = pathname.match(/[_-](\d{3,4}p|sd|hd|fhd|uhd)(?:\.m3u8)?(?:$|[/?])/i);
    const fromPath = normalizeQualityTag(pathMatch?.[1] || "");
    if (fromPath) return fromPath;

    const fromQuery =
      normalizeQualityTag(u.searchParams.get("quality")) ||
      normalizeQualityTag(u.searchParams.get("res")) ||
      normalizeQualityTag(u.searchParams.get("resolution")) ||
      normalizeQualityTag(u.searchParams.get("height"));
    if (fromQuery) return fromQuery;
  } catch {
    return null;
  }
  return null;
}

function qualityRank(value?: string | null) {
  const q = normalizeQualityTag(value);
  if (!q) return -1;
  const n = Number.parseInt(q.replace("p", ""), 10);
  return Number.isFinite(n) ? n : -1;
}

function pickDefaultHlsLevel(levels: Array<{ height?: number }>, preferredHeight = DEFAULT_PLAYER_QUALITY_HEIGHT) {
  const normalized = levels
    .map((level, idx) => ({ idx, height: Number(level?.height) }))
    .filter((item) => Number.isFinite(item.height) && item.height > 0)
    .sort((a, b) => a.height - b.height);

  if (!normalized.length) return -1;

  const exact = normalized.find((item) => item.height === preferredHeight);
  if (exact) return exact.idx;

  const lowerOrEqual = [...normalized].reverse().find((item) => item.height <= preferredHeight);
  if (lowerOrEqual) return lowerOrEqual.idx;

  return normalized[0].idx;
}

function toEmbedProxyUrl(rawUrl?: string | null, ref?: string) {
  if (R2_STRICT_MODE) return "";
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (isRepackPlaylistUrl(value)) return value;
  if (value.startsWith("/api/embed-proxy?")) return value;
  if (!isValidHttpUrl(value)) return "";
  const q = new URLSearchParams();
  q.set("url", value);
  q.set("depth", "0");
  q.set("stable", "1");
  if (ref && isValidHttpUrl(ref)) q.set("ref", ref);
  return `/api/embed-proxy?${q.toString()}`;
}

function formatStartTimeAr(iso?: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function formatTimeOnlyAr(ms?: number | null) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("ar-EG", { timeStyle: "short" }).format(d);
}

function shouldUseNativeHls(video: HTMLVideoElement) {
  const canNative = video.canPlayType("application/vnd.apple.mpegurl");
  if (!canNative) return false;
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  const isSafari =
    ua.includes("safari") && !/(chrome|chromium|crios|edg|opr|opera|fxios|firefox|android)/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua);
  return isSafari || isIOS;
}

function contentTypeLooksLikeHls(contentType: string) {
  const ct = String(contentType || "").toLowerCase();
  return HLS_CT.some((x) => ct.includes(x));
}

function extractManifestMediaUris(manifest: string, maxItems = 4) {
  const out: string[] = [];
  const lines = String(manifest || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractManifestKeyUris(manifest: string, maxItems = 2) {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = String(manifest || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line || !line.startsWith("#EXT-X-KEY")) continue;
    const match = line.match(/URI\s*=\s*(?:(["'])([^"']+)\1|([^,\s]+))/i);
    const uri = String(match?.[2] || match?.[3] || "").trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
    if (out.length >= maxItems) break;
  }
  return out;
}

function toPlayableProxyFromManifestLine(rawLine: string, parentCandidateUrl: string) {
  const line = String(rawLine || "").trim();
  if (!line) return null;
  if (line.startsWith("/api/embed-proxy?")) return line;

  const parentProxyRef =
    parentCandidateUrl.startsWith("/api/embed-proxy?") ? getProxyRefUrlFromCandidate(parentCandidateUrl) : "";
  const parentTarget = parentCandidateUrl.startsWith("/api/embed-proxy?")
    ? getProxyTargetUrl(parentCandidateUrl)
    : isValidHttpUrl(parentCandidateUrl)
      ? parentCandidateUrl
      : null;
  const parentRef =
    parentProxyRef && isValidHttpUrl(parentProxyRef)
      ? parentProxyRef
      : parentTarget && isValidHttpUrl(parentTarget)
        ? parentTarget
        : null;

  if (isValidHttpUrl(line)) {
    return toEmbedProxyUrl(line, parentRef || line);
  }

  if (!parentTarget || !isValidHttpUrl(parentTarget)) return null;
  try {
    const absoluteRaw = new URL(line, parentTarget).toString();
    const absolute = inheritEasybroadcastAuthQuery(absoluteRaw, parentTarget);
    return toEmbedProxyUrl(absolute, parentRef || parentTarget);
  } catch {
    return null;
  }
}

function inheritEasybroadcastAuthQuery(rawChildUrl: string, rawParentUrl: string) {
  if (!isValidHttpUrl(rawChildUrl) || !isValidHttpUrl(rawParentUrl)) return rawChildUrl;
  try {
    const child = new URL(rawChildUrl);
    const parent = new URL(rawParentUrl);
    const childHost = child.hostname.toLowerCase();
    if (!(childHost === "cdn.live.easybroadcast.io" || childHost.endsWith(".easybroadcast.io"))) return rawChildUrl;
    if (child.searchParams.get("token")) return rawChildUrl;

    const token = String(parent.searchParams.get("token") || "").trim();
    const expires = String(parent.searchParams.get("expires") || "").trim();
    const tokenPath = String(parent.searchParams.get("token_path") || "").trim();
    if (!token || !expires) return rawChildUrl;

    if (tokenPath) {
      const decoded = decodeURIComponent(tokenPath).trim().replace(/\/+$/, "");
      if (decoded && !child.pathname.toLowerCase().startsWith(decoded.toLowerCase())) return rawChildUrl;
    }

    child.searchParams.set("token", token);
    child.searchParams.set("expires", expires);
    if (tokenPath) child.searchParams.set("token_path", tokenPath);
    return child.toString();
  } catch {
    return rawChildUrl;
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal
) {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onAbort);
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e: unknown) {
    if (timedOut && e instanceof Error && e.name === "AbortError") {
      throw new Error("probe-timeout");
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  if (!items.length) return [] as R[];
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let cursor = 0;

  const runOne = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runOne()));
  return results;
}

function getUrlOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getServFromUrl(value: string) {
  try {
    const raw = new URL(value).searchParams.get("serv");
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function normalizePathKey(value: string) {
  try {
    const u = new URL(value);
    return u.pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function parseLivehdTvMeta(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return null as null | { pathKey: string; serv: number | null };
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (!(host === "livehd77.pro" || host.endsWith(".livehd77.pro"))) return null;
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (!/^\/tv\/[^/?#]+$/.test(path)) return null;
    let serv: number | null = null;
    const servRaw = String(u.searchParams.get("serv") || "").trim();
    if (servRaw) {
      const n = Number.parseInt(servRaw, 10);
      if (Number.isFinite(n) && n >= 0) serv = n;
    }
    return { pathKey: path, serv };
  } catch {
    return null;
  }
}

function normalizeServer3RootServ(value: number | null | undefined): Server3RootServ {
  if (value === 0) return 0;
  if (value === 1) return 1;
  return null;
}

function server3ProvenanceScore(value?: Server3CandidateProvenance | null) {
  if (!value) return -1;
  if (value.rootServ === 0) return 3;
  if (value.rootServ === 1) return 2;
  if (value.rootPathKey) return 1;
  return 0;
}

function pickBetterServer3Provenance(
  prev: Server3CandidateProvenance | undefined,
  next: Server3CandidateProvenance
) {
  if (!prev) return next;
  const prevScore = server3ProvenanceScore(prev);
  const nextScore = server3ProvenanceScore(next);
  if (nextScore > prevScore) return next;
  return prev;
}

function getProxyRefUrlFromCandidate(value: string) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/api/embed-proxy?")) return "";
  try {
    const u = new URL(raw, "http://localhost");
    const refRaw = String(u.searchParams.get("ref") || "").trim();
    if (!refRaw) return "";
    const decoded = normalizeURIComponent(refRaw);
    return isValidHttpUrl(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function getServer3RootServFromCandidate(
  candidate: string,
  provenanceByKey?: Map<string, Server3CandidateProvenance> | null
) {
  const key = canonicalizeUrl(candidate) || String(candidate || "").trim().toLowerCase();
  const fromMap = key ? provenanceByKey?.get(key)?.rootServ : null;
  if (fromMap === 0 || fromMap === 1) return fromMap;

  const refUrl = getProxyRefUrlFromCandidate(candidate);
  if (refUrl) {
    const refMeta = parseLivehdTvMeta(refUrl);
    const refServ = normalizeServer3RootServ(refMeta?.serv ?? null);
    if (refServ === 0 || refServ === 1) return refServ;

    const refKeys: Array<string | null> = [canonicalizeUrl(refUrl), `proxy:${refUrl.toLowerCase()}`];
    const refProvenance = refKeys
      .filter((k): k is string => !!k)
      .map((k) => provenanceByKey?.get(k))
      .find((v): v is Server3CandidateProvenance => !!v);
    if (refProvenance?.rootServ === 0 || refProvenance?.rootServ === 1) return refProvenance.rootServ;
  }

  const livehdMeta = parseLivehdTvMeta(candidate);
  return normalizeServer3RootServ(livehdMeta?.serv ?? null);
}

function splitServer3CandidatesByRootServ(
  input: string[],
  provenanceByKey?: Map<string, Server3CandidateProvenance> | null
) {
  const deduped = dedupeUrls(input || []);
  const bucket0: string[] = [];
  const bucket1: string[] = [];
  for (const candidate of deduped) {
    const rootServ = getServer3RootServFromCandidate(candidate, provenanceByKey);
    if (rootServ === 0) bucket0.push(candidate);
    else bucket1.push(candidate);
  }
  return { bucket0, bucket1 };
}

function expandLivehdTvServVariants(value: string) {
  const raw = String(value || "").trim();
  if (!isValidHttpUrl(raw)) return [] as string[];

  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (!(host === "livehd77.pro" || host.endsWith(".livehd77.pro"))) return [] as string[];

    const path = u.pathname.toLowerCase();
    if (!/^\/tv\/[^/?#]+\/?$/.test(path)) return [] as string[];

    const currentServRaw = (u.searchParams.get("serv") || "").trim();
    if (currentServRaw && !/^[01]$/.test(currentServRaw)) return [] as string[];

    const order = ["0", "1"];
    const out: string[] = [];
    for (const serv of order) {
      const next = new URL(u.toString());
      next.searchParams.set("serv", serv);
      out.push(next.toString());
    }
    return dedupeUrls(out);
  } catch {
    return [] as string[];
  }
}

function guessPlayerv2TokenPath(url: string) {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("id");
    if (id && /^[a-z0-9_-]+$/i.test(id)) return `${id}.m3u8`;
    const ch = u.searchParams.get("ch");
    if (ch && /^[a-z0-9_-]+$/i.test(ch)) return `${ch}.m3u8`;
    return "";
  } catch {
    return "";
  }
}

function materializeTemplateUrl(raw: string, sourceUrl: string) {
  let value = String(raw || "").trim();
  if (!value.includes("${")) return value;

  let matchId = "";
  try {
    matchId = String(new URL(sourceUrl).searchParams.get("match") || "").trim();
  } catch {}
  if (!matchId) return "";

  const encoded = encodeURIComponent(matchId);
  value = value
    .replace(/\\?\$\{\s*encodeURIComponent\(\s*matchId\s*\)\s*\}/gi, encoded)
    .replace(/\\?\$\{\s*matchId\s*\}/gi, matchId)
    .replace(/\\?\$\{\s*encodeURIComponent\(\s*match\s*\)\s*\}/gi, encoded)
    .replace(/\\?\$\{\s*match\s*\}/gi, matchId);

  return value;
}

function extractServerVariantUrlsFromProxyHtml(html: string, sourceUrl: string) {
  const text = normalizeHtmlForScan(html);
  const sourceOrigin = getUrlOrigin(sourceUrl);
  const sourcePathKey = normalizePathKey(sourceUrl);
  const all = new Set<string>();

  const addRaw = (raw: string) => {
    let candidate = String(raw || "").trim();
    if (!candidate) return;
    if (candidate.startsWith("/api/embed-proxy?")) {
      const target = getProxyTargetUrl(candidate);
      if (!target) return;
      candidate = target;
    }
    candidate = materializeTemplateUrl(candidate, sourceUrl) || candidate;
    if (!isValidHttpUrl(candidate) || !PLAYER_PAGE_HINT_RE.test(candidate)) return;
    const serv = getServFromUrl(candidate);
    if (sourceOrigin && getUrlOrigin(candidate) !== sourceOrigin && serv === null) return;
    const pathKey = normalizePathKey(candidate);
    if (serv === null && pathKey !== sourcePathKey) return;

    const key = canonicalizeUrl(candidate);
    if (!key) return;
    all.add(candidate);
  };

  addRaw(sourceUrl);
  for (const m of text.match(/\/api\/embed-proxy\?[^"'`\s<>()]+/gi) || []) addRaw(m);
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+/gi) || []) addRaw(m);

  const sorted = Array.from(all).sort((a, b) => {
    if (a === sourceUrl) return -1;
    if (b === sourceUrl) return 1;
    const sa = getServFromUrl(a);
    const sb = getServFromUrl(b);
    if (sa !== null && sb !== null) return sa - sb;
    if (sa !== null) return -1;
    if (sb !== null) return 1;
    return a.localeCompare(b);
  });
  return sorted;
}

function extractRollingConfigFromHtml(html: string): AlbaRollingConfig | null {
  const text = normalizeHtmlForScan(html);
  const cfgMatch = text.match(
    /const\s+C\s*=\s*\{[\s\S]*?ch\s*:\s*['"]([^'"]+)['"][\s\S]*?dm\s*:\s*\[([^\]]+)\][\s\S]*?iv\s*:\s*(\d+)/i
  );
  if (cfgMatch?.[1] && cfgMatch?.[2]) {
    const ch = String(cfgMatch[1]).trim();
    if (!ch) return null;
    const dm: string[] = [];
    for (const m of cfgMatch[2].matchAll(/["']([^"']+)["']/g)) {
      const v = String(m[1] || "").trim();
      if (v) dm.push(v);
    }
    const ivRaw = Number.parseInt(String(cfgMatch[3] || ""), 10);
    const iv = Number.isFinite(ivRaw) && ivRaw > 0 ? ivRaw : 1800000;
    if (!dm.length) return null;
    return { ch, dm: Array.from(new Set(dm)), iv };
  }

  // Fallback for pages that build rolling HLS urls like:
  // const D=["domain-a","domain-b"]; ... `https://${prefix}.${D[idx]}/hls/ch9/master.m3u8`
  const domainPoolMatch = text.match(/const\s+D\s*=\s*\[([^\]]+)\]/i);
  const channelMatch = text.match(/\/hls\/([a-z0-9_-]+)\/master\.m3u8/i);
  if (!domainPoolMatch?.[1] || !channelMatch?.[1]) return null;

  const dm: string[] = [];
  for (const m of domainPoolMatch[1].matchAll(/["']([^"']+)["']/g)) {
    const v = String(m[1] || "").trim();
    if (v) dm.push(v);
  }
  if (!dm.length) return null;

  const ch = String(channelMatch[1]).trim();
  if (!ch) return null;

  const intervalExpr =
    text.match(/Date\.now\(\)\s*\/\s*([0-9eE+*.\/\-\s]+)/i)?.[1] ||
    text.match(/Math\.floor\(\s*Date\.now\(\)\s*\/\s*([0-9eE+*.\/\-\s]+)/i)?.[1] ||
    "";
  const ivParsed = (() => {
    const expr = intervalExpr.replace(/\s+/g, "");
    if (!expr || !/^[0-9eE+*.\/-]+$/.test(expr)) return Number.NaN;
    if (/^[0-9eE+.-]+$/.test(expr)) return Number(expr);

    const tokens = expr.split(/([*/])/).filter(Boolean);
    if (!tokens.length || tokens.length % 2 === 0) return Number.NaN;
    let value = Number(tokens[0]);
    if (!Number.isFinite(value)) return Number.NaN;
    for (let i = 1; i < tokens.length; i += 2) {
      const op = tokens[i];
      const next = Number(tokens[i + 1]);
      if (!Number.isFinite(next)) return Number.NaN;
      if (op === "*") value *= next;
      else if (op === "/") value /= next;
      else return Number.NaN;
    }
    return value;
  })();
  const iv = Number.isFinite(ivParsed) && ivParsed > 0 ? Math.round(ivParsed) : 1800000;
  return { ch, dm: Array.from(new Set(dm)), iv };
}

function buildRollingPrefix(ts: number, interval: number, len = 5) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let value = Math.floor(ts / interval);
  let out = "";
  while (out.length < len) {
    out = alphabet[value % 26] + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function extractRollingHlsCandidatesFromHtml(html: string, sourceUrl: string) {
  const cfg = extractRollingConfigFromHtml(html);
  if (!cfg) return [];
  if (isValidHttpUrl(cfg.ch)) return dedupeUrls([toEmbedProxyUrl(cfg.ch, sourceUrl)].filter(Boolean));

  const now = Date.now();
  const slots = [now - cfg.iv, now, now + cfg.iv];
  const out: string[] = [];
  for (const slot of slots) {
    const prefix = buildRollingPrefix(slot, cfg.iv, 5);
    for (const domain of cfg.dm) {
      const abs = `https://${prefix}.${domain}/hls/${cfg.ch}/master.m3u8`;
      const proxied = toEmbedProxyUrl(abs, sourceUrl);
      if (proxied) out.push(proxied);
    }
  }
  return dedupeUrls(out);
}

function extractPlayableCandidatesFromProxyHtml(html: string, sourceUrl: string) {
  const text = String(html || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const out: string[] = [];
  const seen = new Set<string>();
  const isPlayableLike = (value: string) =>
    isStrongPlayableStreamUrl(value) || isLikelyLivePhpEndpointUrl(value);
  const extractJsConcatPlayableUrls = (rawHtml: string) => {
    const localText = String(rawHtml || "")
      .replace(/&amp;/gi, "&")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/");
    const vars = new Map<string, string[]>();
    for (const m of localText.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]{1,800})\]/g)) {
      const varName = String(m[1] || "").trim();
      const arrBody = String(m[2] || "");
      if (!varName || !arrBody) continue;
      const values = Array.from(arrBody.matchAll(/['"]([^'"]{1,200})['"]/g))
        .map((x) => String(x[1] || "").trim())
        .filter(Boolean);
      if (values.length) vars.set(varName, values);
    }
    for (const m of localText.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\[[^\]]+\]/g)) {
      const targetVar = String(m[1] || "").trim();
      const sourceVar = String(m[2] || "").trim();
      if (!targetVar || !sourceVar) continue;
      const sourceValues = vars.get(sourceVar);
      if (sourceValues?.length) vars.set(targetVar, sourceValues);
    }

    const urls: string[] = [];
    for (const m of localText.matchAll(/(['"]https?:\/\/['"])\s*\+\s*([A-Za-z_$][\w$]*)\s*\+\s*(['"][^'"]{1,600}['"])/g)) {
      const prefixRaw = String(m[1] || "");
      const varName = String(m[2] || "").trim();
      const suffixRaw = String(m[3] || "");
      const prefix = prefixRaw.slice(1, -1);
      const suffix = suffixRaw.slice(1, -1);
      if (!prefix || !suffix || !varName) continue;
      const values = vars.get(varName) || [];
      for (const value of values) {
        const resolved = `${prefix}${value}${suffix}`;
        if (isStrongPlayableStreamUrl(resolved) || isLikelyLivePhpEndpointUrl(resolved)) {
          urls.push(resolved);
        }
      }
    }
    return dedupeUrls(urls);
  };
  const add = (raw: string) => {
    let v = String(raw || "").trim().replace(/[),;]+$/g, "");
    if (v.includes("${")) {
      const materialized = materializeTemplateUrl(v, sourceUrl);
      if (materialized) v = materialized;
    }
    if (!v) return;
    if (v.startsWith("/api/embed-proxy?")) {
      const target = getProxyTargetUrl(v);
      if (!target || !isPlayableLike(target)) return;
      const key = canonicalizeUrl(v);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(v);
      return;
    }
    if (!isPlayableLike(v)) return;
    const proxied = toEmbedProxyUrl(v, sourceUrl);
    if (!proxied) return;
    const key = canonicalizeUrl(proxied);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(proxied);
  };
  for (const m of text.match(/\/api\/embed-proxy\?[^"'`\s<>()]+/gi) || []) add(m);
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+\.m3u8[^"'`\s<>()]*/gi) || []) add(m);
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+/gi) || []) add(m);
  for (const m of extractJsConcatPlayableUrls(text)) add(m);
  for (const m of extractPlayableUrlsFromPackedEval(text)) add(m);
  for (const m of extractBase64DecodedUrlsFromHtml(text, sourceUrl)) add(m);
  return out;
}

function isLikelyChannelLandingPlayerPageUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("sia-bth.net") && !host.endsWith("kooraxx.com")) return false;

    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (!path || path === "/") return false;
    if (
      path.startsWith("/wp-") ||
      path.includes("/author/") ||
      path.includes("/tag/") ||
      path.includes("/category/") ||
      path.includes("/feed") ||
      path.includes("/comments") ||
      path.includes("/matches/")
    ) {
      return false;
    }

    const segments = path.split("/").filter(Boolean);
    if (!segments.length || segments.length > 2) return false;
    return segments.every((part) => /^[a-z0-9-]+$/i.test(part));
  } catch {
    return false;
  }
}

function isKnownRelayPlayerPageUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const stream = String(u.searchParams.get("stream") || "").trim();
    if (host.endsWith("popcdn.day") && /\/go\.php$/i.test(path) && !!stream) return true;
    return false;
  } catch {
    return false;
  }
}

function isKnownEmbeddedLivePhpPlayerUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    const knownHost =
      host.endsWith("lifekora.com") ||
      host.endsWith("taktikora.live") ||
      host.endsWith("koora-stream.top") ||
      host.endsWith("dynamicsafari.net");
    if (!knownHost) return false;
    return /\/(?:splayer\/)?live\d+\.php$/i.test(path) || /\/chtv\/ch\d+\.php$/i.test(path);
  } catch {
    return false;
  }
}

function isLikelyYallashootAlbaplayerUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (!host.includes("yallashoot") && !host.includes("yallashot")) return false;
    const path = u.pathname.toLowerCase();
    return path.includes("/albaplayer/") || path.includes("/alba.php");
  } catch {
    return false;
  }
}

function extractYallashootChannelCode(rawSourceUrl: string) {
  const raw = toUnderlyingUrl(String(rawSourceUrl || ""));
  if (!isValidHttpUrl(raw)) return "";
  try {
    const u = new URL(raw);
    const tokens: string[] = [];

    const slug = String(u.pathname.match(/\/albaplayer\/([^/?#]+)/i)?.[1] || "").trim();
    if (slug) tokens.push(slug);

    for (const key of ["ch", "channel", "stream", "id", "src", "match"]) {
      const v = String(u.searchParams.get(key) || "").trim();
      if (v) tokens.push(v);
    }

    for (const token of tokens) {
      const t = decodeURIComponent(token).toLowerCase();
      const hinted =
        t.match(/(?:^|[-_/])(?:ch(?:annel)?|sports?|sport|bein(?:-?sport)?|ad(?:-?sport)?|on)?[-_]?(\d{1,2})(?:$|[-_/])/i)?.[1] ||
        t.match(/(\d{1,2})(?!.*\d)/)?.[1] ||
        "";
      const n = Number.parseInt(hinted, 10);
      if (Number.isFinite(n) && n > 0 && n <= 99) return `ch${n}`;
    }
  } catch {
    return "";
  }
  return "";
}

function shouldUseUnderlyingForRepackSeed(value: string) {
  void value;
  // Keep proxy URLs for repack seeding to preserve upstream headers/tokens across all providers.
  return false;
}

function isDirectAccessDeniedHtml(status: number, html: string) {
  const text = String(html || "").toLowerCase();
  if (!text) return false;
  if (![200, 401, 403, 429].includes(status)) return false;
  return text.includes("direct access not allowed") || text.includes("access not allowed");
}

function buildYallashootDirectHlsFallbackCandidates(sourceUrl: string) {
  const raw = toUnderlyingUrl(String(sourceUrl || ""));
  if (!isLikelyYallashootAlbaplayerUrl(raw)) return [] as string[];

  const channelCode = extractYallashootChannelCode(raw);
  if (!channelCode) return [] as string[];

  try {
    const sourceHost = new URL(raw).hostname.toLowerCase();
    const sourcePrefix = String(sourceHost.split(".")[0] || "").trim().toLowerCase();
    const prefixes = Array.from(new Set([sourcePrefix, "abc"])).filter((x) => /^[a-z0-9-]{2,24}$/i.test(x));
    const domains = Array.from(new Set(YALLASHOOT_DIRECT_HLS_FALLBACK_DOMAINS));
    const pathVariants = [`/hls/${channelCode}/live/index.m3u8`];

    const out: string[] = [];
    for (const prefix of prefixes) {
      for (const domain of domains) {
        for (const path of pathVariants) {
          const candidate = `https://${prefix}.${domain}${path}`;
          const proxied = toEmbedProxyUrl(candidate, raw);
          if (proxied) out.push(proxied);
        }
      }
    }
    return dedupeUrls(out);
  } catch {
    return [] as string[];
  }
}

function isEasybroadcastEventPageUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (!(host === "player.easybroadcast.io" || host.endsWith(".player.easybroadcast.io"))) return false;
    return /^\/events\/[^/?#]+$/i.test(path);
  } catch {
    return false;
  }
}

function getEasybroadcastEventMeta(eventPageUrl: string) {
  try {
    const u = new URL(eventPageUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0].toLowerCase() !== "events") return null;
    const slug = String(parts[1] || "").trim();
    if (!slug) return null;
    const apiUrl = `${u.origin}/api/events/${encodeURIComponent(slug)}`;
    return { slug, apiUrl };
  } catch {
    return null;
  }
}

function parseEasybroadcastTokenQuery(raw: string) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const normalizeParams = (params: URLSearchParams) => {
    const out = new URLSearchParams();
    const token = String(params.get("token") || "").trim();
    const tokenPath = String(params.get("token_path") || params.get("tokenPath") || "").trim();
    const expires = String(params.get("expires") || params.get("expire") || "").trim();
    if (token) out.set("token", token);
    if (tokenPath) out.set("token_path", tokenPath);
    if (expires) out.set("expires", expires);
    if (!out.toString()) return "";
    for (const [k, v] of params.entries()) {
      const key = String(k || "").trim();
      const val = String(v || "").trim();
      if (!key || !val || out.has(key)) continue;
      out.set(key, val);
    }
    return out.toString();
  };

  if (/^[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(parsed || {})) {
        const key = String(k || "").trim();
        const val = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
        if (!key || !val) continue;
        params.set(key, val);
      }
      const fromJson = normalizeParams(params);
      if (fromJson) return fromJson;
    } catch {
      // Ignore JSON parse failure and continue with query parsing.
    }
  }

  const trimmed = text.replace(/^[?#&]+/, "");
  if (!trimmed.includes("=")) return "";
  return normalizeParams(new URLSearchParams(trimmed));
}

function appendQueryToUrl(baseUrl: string, rawQuery: string) {
  const query = String(rawQuery || "").trim().replace(/^[?#&]+/, "");
  if (!isValidHttpUrl(baseUrl) || !query) return baseUrl;
  try {
    const u = new URL(baseUrl);
    const incoming = new URLSearchParams(query);
    incoming.forEach((value, key) => {
      if (!key || !String(value || "").trim()) return;
      u.searchParams.set(key, value);
    });
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function hasEasybroadcastTokenQuery(value?: string | null) {
  const raw = String(value || "").trim();
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    return !!u.searchParams.get("token") && !!u.searchParams.get("expires");
  } catch {
    return false;
  }
}

function isLikelyLivePhpEndpointUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw) || isClearlyNonStreamUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const path = u.pathname.toLowerCase();
    const hasPlay = u.searchParams.has("play");
    const hasStream = u.searchParams.has("stream");
    if (/\/live\d+\.php$/i.test(path) && (hasPlay || hasStream)) return true;
    if (/\/(?:stream|live)\.php$/i.test(path) && (hasPlay || hasStream)) return true;
    return false;
  } catch {
    return false;
  }
}

function isLikelyServer5LookupLandingUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isYallaLike = /\/(?:yalla|watch)\.php(?:[/?#]|$)/i.test(path);
    const isLivePhpLike = /\/(?:player\/)?live\d+\.php(?:[/?#]|$)/i.test(path);
    if (!isYallaLike && !isLivePhpLike) return false;
    if (isYallaLike && !sanitizeServer5ChannelKey(String(u.searchParams.get("id") || ""))) return false;
    const knownHost =
      host === "zxxxeeplay.fun" ||
      host.endsWith(".zxxxeeplay.fun") ||
      host === "codepcplay.fun" ||
      host.endsWith(".codepcplay.fun") ||
      host === "anewssport.fun" ||
      host.endsWith(".anewssport.fun") ||
      host === "playerai.site" ||
      host.endsWith(".playerai.site") ||
      host === "ksohls.ru" ||
      host.endsWith(".ksohls.ru") ||
      host === "s-high.fun" ||
      host.endsWith(".s-high.fun") ||
      host === "scoder.fun" ||
      host.endsWith(".scoder.fun");
    if (knownHost) return true;
    if (!/^[a-z0-9.-]{4,253}$/i.test(host)) return false;
    if (NON_STREAM_HOST_HINTS.some((hint) => host.includes(hint))) return false;
    return true;
  } catch {
    return false;
  }
}

function extractServer5LandingId(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isLikelyServer5LookupLandingUrl(raw)) return "";
  try {
    const u = new URL(raw);
    const fromId = sanitizeServer5ChannelKey(String(u.searchParams.get("id") || ""));
    if (fromId) return fromId;
    const fromStream = sanitizeServer5ChannelKey(String(u.searchParams.get("stream") || ""));
    if (fromStream) return fromStream;
    const fromPlay = sanitizeServer5ChannelKey(String(u.searchParams.get("play") || ""));
    if (fromPlay) return fromPlay;
    return "";
  } catch {
    return "";
  }
}

function isAnewssportMatchPageUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (!(host === "anewssport.fun" || host.endsWith(".anewssport.fun"))) return false;
    return /^\/matches\/[a-z0-9][a-z0-9-]*\/?$/i.test(path);
  } catch {
    return false;
  }
}

function extractAnewssportMatchPageUrlsFromHtml(html: string, baseUrl: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (rawHref: string) => {
    const href = String(rawHref || "").trim();
    if (!href) return;
    let abs = "";
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      abs = "";
    }
    if (!abs) return;
    try {
      const maybeProxy = new URL(abs);
      if (/\/api\/embed-proxy$/i.test(maybeProxy.pathname)) {
        const rawTarget = normalizeURIComponent(maybeProxy.searchParams.get("url") || "");
        if (rawTarget && isValidHttpUrl(rawTarget)) abs = rawTarget;
      }
    } catch { }
    if (!abs || !isAnewssportMatchPageUrl(abs)) return;
    const key = canonicalizeUrl(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(abs);
  };

  const text = String(html || "");
  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const anchor of anchors) push(String(anchor.getAttribute("href") || ""));
  } catch {}

  const normalized = text.replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  for (const m of normalized.match(/https?:\/\/(?:www\.)?anewssport\.fun\/matches\/[a-z0-9-]+\/?/gi) || []) push(m);
  for (const m of normalized.match(/\/matches\/[a-z0-9-]+\/?/gi) || []) push(m);
  for (const m of normalized.match(/\/api\/embed-proxy\?url=https%3A%2F%2Fanewssport\.fun%2Fmatches%2F[a-z0-9-]+%2F[^"'`\s<>()]*/gi) || [])
    push(m);
  return out.slice(0, SERVER5_MATCH_PAGE_SCAN_LIMIT);
}

function extractAnewssportMatchSitemapUrlsFromIndexXml(xml: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const text = String(xml || "");
  for (const m of text.matchAll(/<loc>\s*(https?:\/\/[^<]*wp-sitemap-posts-matches-\d+\.xml)\s*<\/loc>/gi)) {
    const url = String(m[1] || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  if (!out.length) out.push("https://anewssport.fun/wp-sitemap-posts-matches-1.xml");
  return out;
}

function extractAnewssportMatchPageUrlsFromSitemapXml(xml: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const text = String(xml || "");
  for (const m of text.matchAll(/<loc>\s*(https?:\/\/[^<]*\/matches\/[a-z0-9-]+\/?)\s*<\/loc>/gi)) {
    const url = String(m[1] || "").trim();
    if (!url || !isAnewssportMatchPageUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function extractServer5LandingUrlsFromHtml(html: string, baseUrl: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (rawHref: string) => {
    const href = String(rawHref || "").trim();
    if (!href) return;
    let abs = "";
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      abs = "";
    }
    if (!abs) return;
    try {
      const maybeProxy = new URL(abs);
      if (/\/api\/embed-proxy$/i.test(maybeProxy.pathname)) {
        const rawTarget = normalizeURIComponent(maybeProxy.searchParams.get("url") || "");
        if (rawTarget && isValidHttpUrl(rawTarget)) abs = rawTarget;
      }
    } catch { }
    if (!abs || !isLikelyServer5LookupLandingUrl(abs)) return;
    const key = canonicalizeUrl(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(abs);
  };

  const text = String(html || "");
  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const anchors = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>(
        "a[href*='yalla.php?id='], a[href*='watch.php?id='], a[href*='live'][href*='.php'], .MW-Servers a[href]"
      )
    );
    for (const anchor of anchors) push(String(anchor.getAttribute("href") || ""));
  } catch { }

  const normalized = text.replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  for (const m of normalized.match(/https?:\/\/[^"'`\s<>()]+\/(?:yalla|watch)\.php\?[^"'`\s<>()]*/gi) || []) push(m);
  for (const m of normalized.match(/\/(?:yalla|watch)\.php\?[^"'`\s<>()]*/gi) || []) push(m);
  for (const m of normalized.match(/https?:\/\/[^"'`\s<>()]+\/(?:player\/)?live\d+\.php(?:\?[^"'`\s<>()]*)?/gi) || []) push(m);
  for (const m of normalized.match(/\/(?:player\/)?live\d+\.php(?:\?[^"'`\s<>()]*)?/gi) || []) push(m);
  return out.slice(0, SERVER5_LANDING_LIMIT);
}

function extractAnewssportSnsLinksEndpointFromHtml(html: string, baseUrl: string) {
  const text = String(html || "").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  const absolute = text.match(/https?:\/\/[^"'`\s<>()]+\/wp-json\/sns\/v1\/links\?id=\d+/i)?.[0] || "";
  if (absolute && isValidHttpUrl(absolute)) return absolute;
  const relative = text.match(/\/wp-json\/sns\/v1\/links\?id=\d+/i)?.[0] || "";
  if (!relative) return "";
  try {
    return new URL(relative, baseUrl).toString();
  } catch {
    return "";
  }
}

function extractAnewssportEventTeamNamesFromHtml(html: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const text = String(raw || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 2) return;
    const key = normalizeTeamNameForMatchCompare(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  const text = String(html || "");
  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const nodes = Array.from(doc.querySelectorAll(".EventTeamName"));
    for (const node of nodes) push(node.textContent || "");
  } catch { }

  if (!out.length) {
    for (const m of text.matchAll(/class=["'][^"']*EventTeamName[^"']*["'][^>]*>([^<]+)/gi)) {
      push(String(m[1] || ""));
      if (out.length >= 4) break;
    }
  }

  return out.slice(0, 4);
}

function isServer5PageTeamsMatchSearchTerms(pageHtml: string, searchTerms: string[]) {
  const terms = (searchTerms || [])
    .map((value) => normalizeTeamNameForMatchCompare(value))
    .filter((value) => value.length >= 2);
  if (terms.length < 2) return false;

  const pageTeams = extractAnewssportEventTeamNamesFromHtml(pageHtml)
    .map((value) => normalizeTeamNameForMatchCompare(value))
    .filter((value) => value.length >= 2);
  if (pageTeams.length < 2) return false;

  return terms.every((term) =>
    pageTeams.some((team) => team === term || team.includes(term) || term.includes(team) || looseStringSimilarity(team, term) >= 0.66)
  );
}

function extractServer5LandingUrlsFromSnsPayload(rawText: string, baseUrl: string) {
  const out: string[] = [];
  const duplicateCountByKey = new Map<string, number>();
  const push = (rawHref: string) => {
    const href = String(rawHref || "").trim();
    if (!href) return;
    let abs = "";
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      abs = "";
    }
    if (!abs || !isLikelyServer5LookupLandingUrl(abs)) return;
    const key = canonicalizeUrl(abs);
    if (!key) return;
    const nextCount = (duplicateCountByKey.get(key) || 0) + 1;
    duplicateCountByKey.set(key, nextCount);
    if (nextCount > 1) {
      try {
        const tagged = new URL(abs);
        tagged.searchParams.set("s5_slot", String(nextCount));
        abs = tagged.toString();
      } catch {}
    }
    out.push(abs);
  };

  const text = String(rawText || "").trim();
  if (!text) return out;
  try {
    const parsed = JSON.parse(text) as { urls?: unknown } | null;
    const urls = Array.isArray(parsed?.urls) ? parsed?.urls : [];
    for (const item of urls) {
      if (typeof item !== "string") continue;
      push(item);
    }
    if (out.length) return out;
  } catch {}

  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+\/(?:yalla|watch)\.php\?[^"'`\s<>()]*/gi) || []) push(m);
  return out;
}

function sanitizeServer5AuthToken(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.length < 24 || value.length > 640) return "";
  if (!/^[a-z0-9|._-]+$/i.test(value)) return "";
  return value;
}

function sanitizeServer5ChannelSalt(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (!/^[a-f0-9]{32,128}$/i.test(value)) return "";
  return value.toLowerCase();
}

function extractServer5AuthContextFromHtml(html: string) {
  const text = String(html || "");
  if (!text) return null as Server5AuthContext | null;

  const authTokenRaw = text.match(/authToken\s*:\s*['"]([^'"]+)['"]/i)?.[1] || "";
  const channelKeyRaw = text.match(/channelKey\s*:\s*['"]([^'"]+)['"]/i)?.[1] || "";
  const channelSaltRaw = text.match(/channelSalt\s*:\s*['"]([^'"]+)['"]/i)?.[1] || "";

  const authToken = sanitizeServer5AuthToken(authTokenRaw);
  const channelKey = sanitizeServer5ChannelKey(channelKeyRaw);
  const channelSalt = sanitizeServer5ChannelSalt(channelSaltRaw);
  if (!authToken || !channelKey || !channelSalt) return null;

  return { authToken, channelKey, channelSalt };
}

function attachServer5AuthContextToProxyUrl(proxyUrl: string, auth: Server5AuthContext | null) {
  const raw = String(proxyUrl || "").trim();
  if (!auth || !raw.startsWith("/api/embed-proxy?")) return raw;
  const fp = buildServer5FingerprintHints();
  try {
    const u = new URL(raw, "http://localhost");
    u.searchParams.set("s5_ep_auth", auth.authToken);
    u.searchParams.set("s5_ep_ck", auth.channelKey);
    u.searchParams.set("s5_ep_cs", auth.channelSalt);
    u.searchParams.set("s5_fp_sc", fp.dims);
    u.searchParams.set("s5_fp_tz", fp.tz);
    u.searchParams.set("s5_fp_lg", fp.lang);
    return `${u.pathname}?${u.searchParams.toString()}`;
  } catch {
    return raw;
  }
}

function extractServer5AuthContextFromProxyCandidate(candidateUrl: string) {
  const raw = String(candidateUrl || "").trim();
  if (!raw.startsWith("/api/embed-proxy?")) return null as Server5AuthContext | null;
  try {
    const u = new URL(raw, "http://localhost");
    const authToken = sanitizeServer5AuthToken(String(u.searchParams.get("s5_ep_auth") || ""));
    const channelKey = sanitizeServer5ChannelKey(String(u.searchParams.get("s5_ep_ck") || ""));
    const channelSalt = sanitizeServer5ChannelSalt(String(u.searchParams.get("s5_ep_cs") || ""));
    if (!authToken || !channelKey || !channelSalt) return null;
    return { authToken, channelKey, channelSalt };
  } catch {
    return null;
  }
}

function buildServer5FingerprintHints() {
  try {
    const dimsRaw =
      typeof window !== "undefined" && typeof window.screen !== "undefined"
        ? `${window.screen.width}x${window.screen.height}`
        : "0x0";
    const tzRaw = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const langRaw = typeof navigator !== "undefined" ? String(navigator.language || "en") : "en";
    const dims = /^\d{1,5}x\d{1,5}$/i.test(dimsRaw) ? dimsRaw : "0x0";
    const tz = /^[a-z0-9_./+-]{1,80}$/i.test(tzRaw) ? tzRaw : "UTC";
    const lang = /^[a-z0-9-]{1,32}$/i.test(langRaw) ? langRaw : "en";
    return { dims, tz, lang };
  } catch {
    return { dims: "0x0", tz: "UTC", lang: "en" };
  }
}

function buildServer5ProxyAuthHeadersFromCandidate(candidateUrl: string) {
  const auth = extractServer5AuthContextFromProxyCandidate(candidateUrl);
  if (!auth) return {} as Record<string, string>;
  const fp = buildServer5FingerprintHints();
  return {
    "x-s5-auth-token": auth.authToken,
    "x-s5-channel-key": auth.channelKey,
    "x-s5-channel-salt": auth.channelSalt,
    "x-s5-screen": fp.dims,
    "x-s5-timezone": fp.tz,
    "x-s5-language": fp.lang,
  };
}

function sanitizeServer5ChannelKey(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (!/^[a-z0-9_-]{3,64}$/i.test(value)) return "";
  return value;
}

function extractServer5ChannelKeyCandidates(sourceUrl: string, html: string) {
  const out: string[] = [];
  const push = (raw: string) => {
    const v = sanitizeServer5ChannelKey(raw);
    if (!v) return;
    out.push(v);
  };

  const text = String(html || "");
  const lookupVarName = text.match(/server_lookup\?channel_id='\s*\+\s*encodeURIComponent\(\s*([A-Za-z_$][\w$]*)\s*\)/i)?.[1] || "";
  if (lookupVarName) {
    const re = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(lookupVarName)}\\s*=\\s*["']([^"']+)["']`, "i");
    const m = text.match(re);
    if (m?.[1]) push(m[1]);
  }

  for (const m of text.matchAll(/channelKey\s*:\s*['"]([^'"]+)['"]/gi)) push(m[1] || "");
  for (const m of text.matchAll(/authToken\s*:\s*['"]([^'"]+)['"]/gi)) {
    const tokenRaw = String(m[1] || "").trim();
    if (!tokenRaw) continue;
    const tokenParts = tokenRaw.split("|").map((x) => String(x || "").trim()).filter(Boolean);
    if (tokenParts.length) push(tokenParts[0]);
  }

  try {
    const source = new URL(sourceUrl);
    const idRaw = String(source.searchParams.get("id") || "").trim();
    if (idRaw) {
      push(idRaw);
      if (/^\d{2,8}$/.test(idRaw)) push(`yallalive${idRaw}`);
      if (/^cn\d{2,8}$/i.test(idRaw)) push(`yallalive${idRaw.slice(2)}`);
      if (/^cn[a-z0-9_-]{3,64}$/i.test(idRaw)) push(idRaw.slice(2));
    }
  } catch { }

  const ordered = Array.from(new Set(out.map((x) => x.trim()).filter(Boolean)));
  return ordered.slice(0, 6);
}

function extractServer5LookupServerKey(rawLookupText: string) {
  const text = String(rawLookupText || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { server_key?: unknown } | null;
    const key = String(parsed?.server_key || "").trim();
    if (/^[a-z0-9/_-]{2,40}$/i.test(key)) return key;
  } catch { }
  const regexMatch = text.match(/["']server_key["']\s*:\s*["']([a-z0-9/_-]{2,40})["']/i)?.[1] || "";
  if (/^[a-z0-9/_-]{2,40}$/i.test(regexMatch)) return regexMatch;
  return "";
}

function buildServer5DvalnaManifestUrls(serverKeyRaw: string, channelKeyRaw: string) {
  const serverKey = String(serverKeyRaw || "").trim().toLowerCase();
  const channelKey = sanitizeServer5ChannelKey(channelKeyRaw);
  if (!serverKey || !channelKey) return [] as string[];

  if (serverKey === "top1/cdn") {
    return [`https://top1.dvalna.ru/top1/cdn/${channelKey}/mono.css`];
  }

  if (!/^[a-z0-9_-]{2,24}(?:\/[a-z0-9_-]{2,24}){0,2}$/i.test(serverKey)) return [] as string[];
  return [`https://${serverKey}new.dvalna.ru/${serverKey}/${channelKey}/mono.css`];
}

function extractServer5LookupEndpointUrlFromHtml(html: string, baseUrl: string) {
  const text = String(html || "").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  const normalizeEndpoint = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const endpoint = new URL(raw, baseUrl);
      endpoint.search = "";
      endpoint.hash = "";
      if (!/\/server_lookup(?:\.php)?$/i.test(endpoint.pathname)) return "";
      return endpoint.toString();
    } catch {
      return "";
    }
  };

  const absolute =
    text.match(/https?:\/\/[^"'`\s<>()]+\/server_lookup(?:\.php)?(?:\?[^"'`\s<>()]*)?/i)?.[0] || "";
  const normalizedAbsolute = normalizeEndpoint(absolute);
  if (normalizedAbsolute) return normalizedAbsolute;

  const relative = text.match(/\/[^"'`\s<>()]*server_lookup(?:\.php)?(?:\?[^"'`\s<>()]*)?/i)?.[0] || "";
  const normalizedRelative = normalizeEndpoint(relative);
  if (normalizedRelative) return normalizedRelative;

  return "";
}

function buildServer5LookupEndpointCandidates(html: string, landingUrl: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const value = String(raw || "").trim();
    if (!value) return;
    let normalized = "";
    try {
      const endpoint = new URL(value, landingUrl);
      endpoint.search = "";
      endpoint.hash = "";
      if (!/\/server_lookup(?:\.php)?$/i.test(endpoint.pathname)) return;
      normalized = endpoint.toString();
    } catch {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  push(extractServer5LookupEndpointUrlFromHtml(html, landingUrl));
  try {
    const landing = new URL(landingUrl);
    push(`${landing.origin}/server_lookup`);
    push(`${landing.origin}/server_lookup.php`);
  } catch { }
  for (const endpoint of SERVER5_LOOKUP_ENDPOINT_FALLBACKS) push(endpoint);
  return out.slice(0, 5);
}

function prioritizeServer5LookupEndpointCandidates(
  endpoints: string[],
  landingUrl: string,
  mode: "fast" | "final"
) {
  const unique = dedupeUrls(endpoints);
  if (!unique.length) return [] as string[];

  let landingHost = "";
  try {
    landingHost = new URL(landingUrl).hostname.toLowerCase();
  } catch { }

  const ranked = unique
    .map((url, index) => {
      let host = "";
      let score = index === 0 ? 80 : 0;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch { }

      if (host) {
        if (isServer5StackHost(host)) score += 40;
        if (host === "chevy.soyspace.cyou" || host.endsWith(".soyspace.cyou")) score += 60;
        if (host === "chevy.dvalna.ru" || host.endsWith(".dvalna.ru")) score += mode === "fast" ? -10 : 5;
        if (landingHost && host === landingHost) score += isServer5StackHost(host) ? 20 : -25;
      }

      return { url, host, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const out: string[] = [];
  const limit = mode === "fast" ? SERVER5_FAST_LOOKUP_ENDPOINT_LIMIT : SERVER5_FINAL_LOOKUP_ENDPOINT_LIMIT;
  const firstOriginal = unique[0] || "";
  for (const entry of ranked) {
    if (mode === "fast") {
      const isFirstOriginal = entry.url === firstOriginal;
      const isStack = !!entry.host && isServer5StackHost(entry.host);
      if (!isFirstOriginal && !isStack) continue;
    }
    out.push(entry.url);
    if (out.length >= limit) break;
  }

  if (!out.length && firstOriginal) return [firstOriginal];
  return out;
}

function buildServer5ManifestUrls(
  serverKeyRaw: string,
  channelKeyRaw: string,
  lookupEndpointUrl?: string | null,
  mode: "fast" | "final" = "final"
) {
  const channelKey = sanitizeServer5ChannelKey(channelKeyRaw);
  const serverKey = String(serverKeyRaw || "").trim().toLowerCase();
  if (!channelKey || !serverKey) return [] as string[];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const v = String(value || "").trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  const endpointRaw = String(lookupEndpointUrl || "").trim();
  let addedEndpointProxy = false;
  if (endpointRaw && /^[a-z0-9/_-]{2,40}$/i.test(serverKey)) {
    try {
      const endpoint = new URL(endpointRaw);
      const origin = endpoint.origin;
      for (const ext of ["m3u8", "css"]) {
        if (serverKey === "top1/cdn") {
          push(`${origin}/proxy/top1/cdn/${channelKey}/mono.${ext}`);
        } else {
          push(`${origin}/proxy/${serverKey}/${channelKey}/mono.${ext}`);
        }
        addedEndpointProxy = true;
      }
    } catch { }
  }

  const includeDvalnaFallback = mode !== "fast";
  if (includeDvalnaFallback) {
    for (const value of buildServer5DvalnaManifestUrls(serverKey, channelKey)) push(value);
  } else if (!addedEndpointProxy) {
    // Fast mode stays origin-only for Server 5 to avoid slow dvalna retries.
    return [];
  }

  return out;
}

function buildServer5SearchTerms(values: Array<string | null | undefined>) {
  const out: string[] = [];
  const seen = new Set<string>();
  const maybeDecodePercentEncoded = (raw: string) => {
    const value = String(raw || "").trim();
    if (!/%[0-9a-f]{2}/i.test(value)) return "";
    let current = value;
    for (let i = 0; i < 3; i += 1) {
      if (!/%[0-9a-f]{2}/i.test(current)) break;
      try {
        const decoded = decodeURIComponent(current).trim();
        if (!decoded || decoded === current) break;
        current = decoded;
      } catch {
        break;
      }
    }
    return current !== value ? current : "";
  };
  const push = (raw: string) => {
    const term = String(raw || "").replace(/\s+/g, " ").trim();
    if (term.length < 2 || term.length > 120) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  for (const value of values) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const decodedText = maybeDecodePercentEncoded(text);
    if (decodedText) push(decodedText);
    push(text);
    push(
      text
        .replace(/(^|\s)نادي\s+/g, "$1")
        .replace(/\b(?:club|fc|sc|cf)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    const normalized = text.replace(/[^a-z0-9\u0600-\u06ff\s-]+/gi, " ").replace(/\s+/g, " ").trim();
    const decodedNormalized = maybeDecodePercentEncoded(normalized);
    if (decodedNormalized) push(decodedNormalized);
    push(normalized);
    if (out.length >= 6) break;
  }

  return out.slice(0, 6);
}

function normalizeTeamNameForMatchCompare(value?: string | null) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0610-\u061a]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function buildStringBigrams(value: string) {
  const input = String(value || "").trim();
  if (!input) return new Set<string>();
  if (input.length < 2) return new Set<string>([input]);
  const out = new Set<string>();
  for (let i = 0; i < input.length - 1; i += 1) out.add(input.slice(i, i + 2));
  return out;
}

function looseStringSimilarity(a: string, b: string) {
  const left = normalizeTeamNameForMatchCompare(a);
  const right = normalizeTeamNameForMatchCompare(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;

  const aGram = buildStringBigrams(left);
  const bGram = buildStringBigrams(right);
  if (!aGram.size || !bGram.size) return 0;

  let overlap = 0;
  for (const token of aGram) {
    if (bGram.has(token)) overlap += 1;
  }
  const denom = Math.max(aGram.size, bGram.size);
  return denom > 0 ? overlap / denom : 0;
}

function isLikelyLivehdScheduleMatchPageUrl(value?: string | null) {
  const raw = String(value || "").trim();
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (!(host === "livehd77.pro" || host.endsWith(".livehd77.pro"))) return false;
    if (path === "/" || /\/(?:matches-today|matches-yesterday|matches-tomorrow|liive)\/?$/i.test(path)) return false;
    if (path.includes("/category/") || path.includes("/tag/") || path.includes("/author/")) return false;
    return true;
  } catch {
    return false;
  }
}

function pickServer3LivehdFallbackPageUrl(html: string, homeTeam?: string | null, awayTeam?: string | null) {
  const page = String(html || "");
  if (!page) return "";
  const homeNorm = normalizeTeamNameForMatchCompare(homeTeam);
  const awayNorm = normalizeTeamNameForMatchCompare(awayTeam);
  if (!homeNorm && !awayNorm) return "";

  try {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const anchors = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>(
        ".MatchITem a[href], .match-item a[href], .matchItem a[href], .live-match a[href], a[href*='livehd77.pro/']"
      )
    );
    let bestUrl = "";
    let bestScore = 0;

    for (const anchor of anchors) {
      const href = String(anchor.getAttribute("href") || "").trim();
      if (!href) continue;
      let absHref = "";
      try {
        absHref = new URL(href, "https://livehd77.pro/matches-today/").toString();
      } catch {
        absHref = "";
      }
      if (!absHref) continue;
      try {
        const maybeProxy = new URL(absHref);
        if (/\/api\/embed-proxy$/i.test(maybeProxy.pathname)) {
          const rawTarget = normalizeURIComponent(maybeProxy.searchParams.get("url") || "");
          if (rawTarget && isValidHttpUrl(rawTarget)) absHref = rawTarget;
        }
      } catch { }
      if (!isLikelyLivehdScheduleMatchPageUrl(absHref)) continue;

      const hostText = normalizeTeamNameForMatchCompare(
        anchor.querySelector(".host span, .team-home span, .home span, .home-team span")?.textContent || ""
      );
      const guestText = normalizeTeamNameForMatchCompare(
        anchor.querySelector(".guest span, .team-away span, .away span, .away-team span")?.textContent || ""
      );
      const allText = normalizeTeamNameForMatchCompare(anchor.textContent || "");

      const directScore = looseStringSimilarity(homeNorm, hostText) + looseStringSimilarity(awayNorm, guestText);
      const swapScore = looseStringSimilarity(homeNorm, guestText) + looseStringSimilarity(awayNorm, hostText);
      const textScore = looseStringSimilarity(homeNorm, allText) + looseStringSimilarity(awayNorm, allText);
      const score = Math.max(directScore, swapScore, textScore * 0.9);

      if (score > bestScore) {
        bestScore = score;
        bestUrl = absHref;
      }
    }

    return bestScore >= 0.7 ? bestUrl : "";
  } catch {
    return "";
  }
}

function decodeBase64Literal(raw: string) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return "";
  if (value.length % 4) value = `${value}${"=".repeat(4 - (value.length % 4))}`;
  try {
    return atob(value);
  } catch {
    return "";
  }
}

function extractBase64DecodedUrlsFromHtml(html: string, sourceUrl: string) {
  const text = normalizeHtmlForScan(html)
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\\(["'])/g, "$1");
  const tokens = new Set<string>();
  const addToken = (raw: string) => {
    const v = String(raw || "").trim();
    if (!v || v.length < 8 || v.length > 4096) return;
    tokens.add(v);
  };

  for (const m of text.matchAll(/atob\(\s*(['"])([A-Za-z0-9+/_=-]{8,})\1\s*\)/gi)) addToken(m[2] || "");
  for (const m of text.matchAll(/\b(?:encoded(?:url|src)?|base64(?:url|src)?|b64(?:url|src)?)\b\s*[:=]\s*\\?(['"])([A-Za-z0-9+/_=-]{8,})\\?\1/gi))
    addToken(m[2] || "");
  // AlbaPlayer (Server 4) frequently embeds HLS urls as base64 literals:
  // AlbaPlayerControl('aHR0cHM6Ly8uLi5zdHJlYW0ubTN1OA==','plyr');
  for (const m of text.matchAll(/AlbaPlayerControl\(\s*\\?(['"])([A-Za-z0-9+/_=-]{16,})\\?\1\s*,\s*\\?(['"])([a-z0-9_-]{2,16})\\?\3/gi))
    addToken(m[2] || "");

  const out = new Set<string>();
  const addResolved = (raw: string) => {
    const value = String(raw || "").trim();
    if (!value) return;
    if (isValidHttpUrl(value)) {
      out.add(value);
      return;
    }
    const looksRelativePhp = /^(?:\/|\.\/|\.\.\/|[a-z0-9_.-]+\/|[a-z0-9_.-]+\.php)/i.test(value);
    const looksPlayableHint = /\.php/i.test(value) || /[?&](?:play|stream)=/i.test(value);
    if (!looksRelativePhp || !looksPlayableHint) return;
    try {
      const abs = new URL(value, sourceUrl).toString();
      if (isValidHttpUrl(abs)) out.add(abs);
    } catch { }
  };

  for (const token of tokens) {
    const decoded = decodeBase64Literal(token);
    if (!decoded) continue;
    const normalized = normalizeHtmlForScan(decoded)
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/\\(["'])/g, "$1");
    for (const m of normalized.match(/https?:\/\/[^"'`\s<>()]+/gi) || []) addResolved(m);
    for (const m of normalized.match(/(?:^|[\s"'`=])((?:\/|\.\/|\.\.\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.php(?:\?[^"'`\s<>()]+)?)/gi) || []) {
      const rel = String(m || "").replace(/^[\s"'`=]+/, "");
      addResolved(rel);
    }
  }

  return Array.from(out);
}



function isLikelyLivehdMirrorIframePageUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (!(host === "blogspot.com" || host.endsWith(".blogspot.com"))) return false;
    return /^\/p\/[a-z0-9-]+\.html$/i.test(path);
  } catch {
    return false;
  }
}

function isLivehdServer3ChainUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "livehd77.pro" || host.endsWith(".livehd77.pro") || host.includes("alkoora.live");
  } catch {
    return false;
  }
}

function isLivehdExternalRelayUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const servRaw = String(u.searchParams.get("serv") || "").trim();
    const serv = Number.parseInt(servRaw, 10);
    const isKorasimoRelayHost =
      host.includes("korasimo") ||
      host.endsWith(".popcdn.day") ||
      host === "popcdn.day" ||
      host.endsWith(".lovetier.bz") ||
      host === "lovetier.bz" ||
      host.endsWith(".lovecdn.ru");
    const isKorasimoServVariant =
      (host.includes("alkoora.live") || host.endsWith(".alkoora.live")) &&
      path.includes("/albaplayer/") &&
      Number.isFinite(serv) &&
      serv === 2;
    return isKorasimoRelayHost || isKorasimoServVariant;
  } catch {
    return false;
  }
}

function extractPlayerPageCandidatesFromProxyHtml(html: string, sourceUrl: string) {
  const text = String(html || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const out: string[] = [];
  const seen = new Set<string>();
  const sourceIsLivehdServer3Chain = isLivehdServer3ChainUrl(sourceUrl);
  const isPlayerLike = (url: string) =>
    PLAYER_PAGE_HINT_RE.test(url) ||
    isLikelyChannelLandingPlayerPageUrl(url) ||
    isKnownRelayPlayerPageUrl(url) ||
    isKnownEmbeddedLivePhpPlayerUrl(url) ||
    isLikelyLivehdMirrorIframePageUrl(url) ||
    isEasybroadcastEventPageUrl(url);
  const add = (raw: string) => {
    let v = String(raw || "").trim().replace(/[),;]+$/g, "");
    if (v.includes("${")) {
      const materialized = materializeTemplateUrl(v, sourceUrl);
      if (materialized) v = materialized;
    }
    if (!v) return;
    if (isPlayerv2TokenEndpointUrl(v)) return;

    if (v.startsWith("/api/embed-proxy?")) {
      const target = getProxyTargetUrl(v);
      if (!target || !isValidHttpUrl(target)) return;
      const expandedTargets = dedupeUrls([target, ...expandLivehdTvServVariants(target)]);
      for (const candidate of expandedTargets) {
        if (isPlayerv2TokenEndpointUrl(candidate)) continue;
        if (sourceIsLivehdServer3Chain && isLivehdExternalRelayUrl(candidate)) continue;
        if (isClearlyNonStreamUrl(candidate) || isStrongPlayableStreamUrl(candidate) || isLikelyLivePhpEndpointUrl(candidate))
          continue;
        if (!isPlayerLike(candidate)) continue;
        const proxied = toEmbedProxyUrl(candidate, sourceUrl);
        if (!proxied) continue;
        const key = canonicalizeUrl(proxied);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(proxied);
      }
      return;
    }

    if (!isValidHttpUrl(v)) return;
    const expanded = dedupeUrls([v, ...expandLivehdTvServVariants(v)]);
    for (const candidate of expanded) {
      if (isPlayerv2TokenEndpointUrl(candidate)) continue;
      if (sourceIsLivehdServer3Chain && isLivehdExternalRelayUrl(candidate)) continue;
      if (isClearlyNonStreamUrl(candidate) || isStrongPlayableStreamUrl(candidate) || isLikelyLivePhpEndpointUrl(candidate))
        continue;
      if (!isPlayerLike(candidate)) continue;
      const proxied = toEmbedProxyUrl(candidate, sourceUrl);
      if (!proxied) continue;
      const key = canonicalizeUrl(proxied);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(proxied);
    }
  };

  for (const variant of expandLivehdTvServVariants(sourceUrl)) add(variant);
  for (const m of text.match(/\/api\/embed-proxy\?[^"'`\s<>()]+/gi) || []) add(m);
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+/gi) || []) add(m);
  for (const m of text.match(/https?:\/\/[^\s"'`<>()]+\/playerv2\.php\?[^"'`\s<>]*\$\{encodeURIComponent\(\s*matchId\s*\)\}[^"'`\s<>]*/gi) || [])
    add(m);
  for (const m of text.match(/https?:\/\/[^\s"'`<>()]+\/playerv2\.php\?[^"'`\s<>]*\$\{matchId\}[^"'`\s<>]*/gi) || [])
    add(m);
  for (const m of extractBase64DecodedUrlsFromHtml(text, sourceUrl)) add(m);
  return out;
}

function dedupeUrls(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalizeUrl(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function candidateFailureKey(value: string) {
  return canonicalizeUrl(value) || String(value || "").trim().toLowerCase();
}

function isLikelyExpiredReplayManifestUrl(value: string) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw || !isValidHttpUrl(raw)) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("video.pscp.tv/") ||
    lower.includes("periscope-replay-direct") ||
    lower.includes("dynamic_highlatency.m3u8")
  );
}

function scoreServer3Candidate(value: string) {
  const raw = toUnderlyingUrl(String(value || ""));
  if (!raw || !isValidHttpUrl(raw)) return 0;

  let score = 0;
  const lower = raw.toLowerCase();
  const livehdMeta = parseLivehdTvMeta(raw);
  if (lower.includes("pl.gomatch-live.com")) score += 320;
  if (lower.includes("pandalive.live")) score += 220;
  if (lower.includes("livehd77.pro")) score += 120;
  if (lower.includes("/albaplayer/")) score += 90;
  if (lower.includes("starzplayarabia.com")) score += 260;
  if (lower.includes("/admn_tv_enc/abudhabi_sports_1/")) score += 120;
  if (/[?&]serv=0(?:&|$)/i.test(lower)) score += 240;
  if (/[?&]serv=1(?:&|$)/i.test(lower)) score -= 80;
  if (livehdMeta?.serv === 1) score -= 220;
  if (livehdMeta?.serv === 0) score += 140;
  if (SEGMENT_FILE_RE.test(lower)) score -= 900;
  if (lower.includes("cdn3.yalla-online.click/chtv/")) score -= 120;
  if (isLikelyExpiredReplayManifestUrl(lower)) score -= 500;

  return score;
}

function toServer3CandidateIdentity(value: string) {
  const raw = value.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(value) || value : value;
  if (!isValidHttpUrl(raw)) return canonicalizeUrl(value) || String(value || "").trim().toLowerCase();

  try {
    const u = new URL(raw);
    const params = new URLSearchParams(u.search);
    for (const key of [
      "ts",
      "token",
      "token_path",
      "sid",
      "nonce",
      "nimblesessionid",
      "expires",
      "exp",
      "signature",
      "sig",
      "auth",
      "key",
      "q",
      "quality",
      "res",
      "resolution",
      "br",
      "bitrate",
      "height",
      "width",
    ]) {
      params.delete(key);
    }

    const parts = u.pathname
      .toLowerCase()
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean);
    const qualityTokenRe = /^(?:\d{3,4}p|\d{3,4}k|sd|hd|fhd|uhd|low|mid|high)$/i;

    if (parts.length) {
      const last = parts[parts.length - 1];
      if (/\.m3u8$/i.test(last)) {
        const stem = last.replace(/\.m3u8$/i, "");
        if (/^(?:index|master|playlist|mainindex|chunklist|live|stream)$/i.test(stem) || qualityTokenRe.test(stem)) {
          parts.pop();
        }
      }
    }
    if (parts.length && qualityTokenRe.test(parts[parts.length - 1])) parts.pop();

    const path = parts.length ? `/${parts.join("/")}` : u.pathname.toLowerCase().replace(/\/+$/, "");
    const stableParams = Array.from(params.entries())
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    return `${u.hostname.toLowerCase()}${path}${stableParams ? `?${stableParams}` : ""}`;
  } catch {
    return canonicalizeUrl(value) || String(value || "").trim().toLowerCase();
  }
}

function collapseServer3EquivalentCandidates(values: string[]) {
  const out = new Map<string, string>();
  for (const value of dedupeUrls(values)) {
    const id = toServer3CandidateIdentity(value);
    const existing = out.get(id);
    if (!existing) {
      out.set(id, value);
      continue;
    }
    if (scoreServer3Candidate(value) > scoreServer3Candidate(existing)) {
      out.set(id, value);
    }
  }
  return Array.from(out.values());
}

function scoreServer5Candidate(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return 0;

  let score = 0;
  const auth = extractServer5AuthContextFromProxyCandidate(raw);
  if (auth) {
    score += 380;
    if (auth.channelKey.toLowerCase().startsWith("yallalive")) score += 140;
  } else if (raw.startsWith("/api/embed-proxy?")) {
    score -= 120;
  }
  try {
    const proxyUrl = new URL(raw, "http://localhost");
    const channelKey = sanitizeServer5ChannelKey(String(proxyUrl.searchParams.get("s5_ep_ck") || "")).toLowerCase();
    if (channelKey.startsWith("yallalive")) score += 500;
    else if (channelKey.startsWith("premium")) score += 260;
    else if (channelKey.startsWith("cnpremium")) score -= 140;

    const ref = normalizeURIComponent(String(proxyUrl.searchParams.get("ref") || ""));
    const refId = extractServer5LandingId(ref).toLowerCase();
    if (refId.startsWith("yallalive")) score += 130;
    else if (/^\d{2,8}$/.test(refId)) score += 90;
    else if (refId.startsWith("premium")) score += 50;
    else if (refId.startsWith("cnpremium")) score -= 120;

    const slot = Number.parseInt(String(proxyUrl.searchParams.get("s5_slot") || "0"), 10);
    if (Number.isFinite(slot) && slot > 0) {
      // Current upstream tends to have the healthiest feed in slot=2.
      if (slot === 2) score += 420;
      else if (slot === 1) score += 80;
      else score += Math.max(0, 60 - slot * 4);
    }
  } catch { }

  return score;
}

function isFastFailoverServer(server: number) {
  return server === 1 || server === 5;
}

function escapeRegExp(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeJsPackedLiteral(raw: string) {
  return String(raw || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/\\'/g, "'")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function encodePackedIndex(index: number, radix: number) {
  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const base = Number.isFinite(radix) ? Math.floor(radix) : 10;
  if (base >= 2 && base <= 36) return index.toString(base);
  if (base > 36 && base <= digits.length) {
    if (index === 0) return "0";
    let n = index;
    let out = "";
    while (n > 0) {
      out = digits[n % base] + out;
      n = Math.floor(n / base);
    }
    return out;
  }
  return index.toString(10);
}

function unpackDeanEdwardsPacker(packed: string, radix: number, count: number, dictionary: string[]) {
  let out = String(packed || "");
  const max = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const base = Number.isFinite(radix) ? Math.floor(radix) : 10;
  for (let i = max - 1; i >= 0; i -= 1) {
    const replacement = dictionary[i];
    if (!replacement) continue;
    const token = encodePackedIndex(i, base);
    if (!token) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"), replacement);
  }
  return out;
}

function extractPlayableUrlsFromPackedEval(html: string) {
  const out = new Set<string>();
  const pattern =
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(\s*['"]\|['"]\s*\)/g;

  for (const m of html.matchAll(pattern)) {
    const packed = decodeJsPackedLiteral(m[2] || "");
    const radix = Number.parseInt(m[3] || "10", 10);
    const count = Number.parseInt(m[4] || "0", 10);
    const dictionary = decodeJsPackedLiteral(m[6] || "").split("|");
    if (!packed || !Number.isFinite(radix) || !Number.isFinite(count)) continue;

    const unpacked = unpackDeanEdwardsPacker(packed, radix, count, dictionary);
    for (const urlMatch of unpacked.matchAll(/https?:\/\/[^"'`\s<>()]+/gi)) {
      const value = String(urlMatch[0] || "").trim();
      if (!value) continue;
      out.add(value);
    }
  }

  return Array.from(out);
}

function normalizeHostRoot(hostname: string) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return host;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return host;

  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;

  const secondLevel = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const maybeThirdLevelTld = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
  if (tld.length === 2 && maybeThirdLevelTld.has(secondLevel) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function toCandidateGroupKey(value: string) {
  const raw = value.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(value) || value : value;
  if (!isValidHttpUrl(raw)) return canonicalizeUrl(value) || String(value || "").trim().toLowerCase();

  try {
    const u = new URL(raw);
    const host = normalizeHostRoot(u.hostname);
    const params = new URLSearchParams(u.search);

    for (const key of [
      "ts",
      "token",
      "token_path",
      "sid",
      "nonce",
      "nimblesessionid",
      "expires",
      "exp",
      "signature",
      "sig",
      "auth",
      "key",
      "q",
      "quality",
      "res",
      "resolution",
      "br",
      "bitrate",
      "height",
      "width",
    ]) {
      params.delete(key);
    }

    const parts = u.pathname
      .toLowerCase()
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean);
    const qualityTokenRe = /^(?:\d{3,4}p|\d{3,4}k|sd|hd|fhd|uhd|low|mid|high)$/i;
    const isYallaShotFamily = host.includes("yallashot") || host.includes("yallashoot");

    // Server 2 (playerv2) can emit both `/kooora/<slug>` and `/kooora/<slug>.m3u8` for the same feed.
    // Collapse them to one source group so the UI doesn't show a fake extra source.
    if (isYallaShotFamily && parts.length >= 2 && parts[0] === "hls" && parts[1] === "kooora") {
      parts.shift();
    }
    if (isYallaShotFamily && parts.length >= 2 && parts[0] === "kooora") {
      const last = parts[parts.length - 1];
      if (/\.m3u8$/i.test(last)) {
        parts[parts.length - 1] = last.replace(/\.m3u8$/i, "");
      }
    }

    if (parts.length) {
      const last = parts[parts.length - 1];
      if (/\.m3u8$/i.test(last)) {
        const stem = last.replace(/\.m3u8$/i, "");
        if (/^(?:index|master|playlist|mainindex|chunklist|live|stream)$/i.test(stem) || qualityTokenRe.test(stem)) {
          parts.pop();
        }
      }
    }
    if (parts.length && qualityTokenRe.test(parts[parts.length - 1])) parts.pop();

    const path = parts.length ? `/${parts.join("/")}` : "";
    const stableParams = Array.from(params.entries())
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const quality = extractQualityTagFromUrl(value) || "auto";

    return `${host}${path}${stableParams ? `?${stableParams}` : ""}|q=${quality}`;
  } catch {
    return canonicalizeUrl(value) || String(value || "").trim().toLowerCase();
  }
}

function groupCandidates(values: string[]) {
  const map = new Map<string, CandidateGroup>();
  values.forEach((candidate, idx) => {
    const key = toCandidateGroupKey(candidate);
    const quality = extractQualityTagFromUrl(candidate);
    const label = quality ? quality : "";
    const existing = map.get(key);
    if (existing) {
      existing.members.push(idx);
      if (!existing.label && label) existing.label = label;
      return;
    }
    map.set(key, { key, primaryIndex: idx, members: [idx], label });
  });

  const sorted = Array.from(map.values()).sort((a, b) => {
    const aq = qualityRank(a.label);
    const bq = qualityRank(b.label);
    if (aq !== bq) return bq - aq;
    return a.primaryIndex - b.primaryIndex;
  });

  const familyHasQuality = new Set<string>();
  let hasAnyQuality = false;
  for (const group of sorted) {
    if (qualityRank(group.label) < 0) continue;
    hasAnyQuality = true;
    const family = group.key.split("|q=")[0] || group.key;
    familyHasQuality.add(family);
  }

  const filtered = sorted.filter((group) => {
    if (qualityRank(group.label) >= 0) return true;
    const family = group.key.split("|q=")[0] || group.key;
    const familyLower = family.toLowerCase();
    const isEasybroadcastFamily = /easybroadcast\.io/i.test(familyLower);
    const isLandingPlayerFamily = /\/albaplayer\/|\/tv\/|player\.easybroadcast\.io\/events\//i.test(familyLower);
    if (familyHasQuality.has(family) && isEasybroadcastFamily) return false;
    if (hasAnyQuality && (isEasybroadcastFamily || isLandingPlayerFamily)) return false;
    return true;
  });

  return filtered.length ? filtered : sorted;
}

function normalizeHtmlForScan(html: string) {
  return String(html || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
}

function ensureTrailingSlash(raw?: string | null) {
  const v = String(raw || "").trim();
  if (!v || !isValidHttpUrl(v)) return "";
  return v.endsWith("/") ? v : `${v}/`;
}

function normalizePlayerv2Path(raw?: string | null) {
  let v = String(raw || "").trim();
  if (!v) return "";
  if (isValidHttpUrl(v)) {
    try {
      const u = new URL(v);
      v = `${u.pathname}${u.search}`.replace(/^\//, "");
    } catch {
      return "";
    }
  }
  v = v.replace(/^\/+/, "").split("?")[0].split("#")[0];
  if (v.endsWith(".m3u8")) v = v.slice(0, -5);
  if (!v) return "";
  if (!v.startsWith("kooora/")) v = `kooora/${v}`;
  return v.replace(/\/{2,}/g, "/");
}

function extractPlayerv2ConfigFromHtml(html: string, pageUrl: string) {
  const text = normalizeHtmlForScan(html);
  const paths = new Set<string>();
  const domains = new Set<string>();

  const cfgMatch = text.match(PLAYERV2_CONFIG_RE);
  if (cfgMatch?.[1]) {
    try {
      const cfg = JSON.parse(cfgMatch[1]) as {
        tabs?: Array<{ path?: string; mobile_path?: string }>;
        activeDomains?: string[];
      };
      for (const tab of Array.isArray(cfg.tabs) ? cfg.tabs : []) {
        if (tab?.path) paths.add(tab.path);
        if (tab?.mobile_path) paths.add(tab.mobile_path);
      }
      for (const domain of Array.isArray(cfg.activeDomains) ? cfg.activeDomains : []) {
        const normalized = ensureTrailingSlash(domain);
        if (normalized) domains.add(normalized);
      }
    } catch { }
  }

  for (const m of text.matchAll(/data-(?:mobile-)?path=["']([^"']+)["']/gi)) {
    const v = String(m[1] || "").trim();
    if (v) paths.add(v);
  }

  // Always include the page origin as a candidate domain when possible.
  // Some playerv2 variants don't expose activeDomains/tabsConfig, so we need fallbacks too.
  let pageHost = "";
  try {
    const u = new URL(pageUrl);
    pageHost = String(u.hostname || "").toLowerCase();
    const origin = ensureTrailingSlash(u.origin);
    if (origin) domains.add(origin);
  } catch { }

  // YallaShot playerv2 pages often omit activeDomains; add known working subdomains.
  if (pageHost.endsWith("yallashot.us")) {
    for (const fallback of PLAYERV2_FALLBACK_DOMAINS) {
      const normalized = ensureTrailingSlash(fallback);
      if (normalized) domains.add(normalized);
    }
  }

  return {
    paths: Array.from(paths).map((p) => normalizePlayerv2Path(p)).filter(Boolean),
    domains: Array.from(domains),
  };
}

function buildPlayerv2NonceCandidates() {
  // playerv2 nonces observed in the wild are short alnum (often 6 chars), sometimes longer.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const pick = (len: number) => {
    let out = "";
    for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  };
  const base36 = (len: number) => {
    let out = "";
    while (out.length < len) out += Math.random().toString(36).slice(2);
    return out.slice(0, len);
  };
  return Array.from(new Set([base36(6), pick(6), pick(8)])).filter(Boolean);
}

function computePlayerv2CanvasFingerprint() {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    canvas.width = 200;
    canvas.height = 50;
    ctx.textBaseline = "top";
    ctx.font = '14px "Arial"';
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("Browser Fingerprint 🔒", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("Canvas Test 123", 4, 17);

    const txt = canvas.toDataURL();
    let hash = 0;
    for (let i = 0; i < txt.length; i += 1) {
      const code = txt.charCodeAt(i);
      hash = ((hash << 5) - hash) + code;
      hash |= 0;
    }

    const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (typeof renderer === "string") hash ^= renderer.length;
      }
    }

    return Math.abs(hash).toString(36);
  } catch {
    return null;
  }
}

async function requestPlayerv2TokenFromProxy(
  playerv2Url: string,
  tokenPath: string,
  signal?: AbortSignal,
  pushDiag?: (line: string) => void
) {
  const cachedFresh = getCachedPlayerv2Token(playerv2Url, tokenPath, false);
  if (cachedFresh) {
    pushDiag?.("playerv2 token cache hit");
    return cachedFresh;
  }
  const cachedStale = getCachedPlayerv2Token(playerv2Url, tokenPath, true);

  const endpoint = (() => {
    try {
      return new URL("/playerv2.php?action=generate_token", playerv2Url).toString();
    } catch {
      return "";
    }
  })();
  if (!endpoint) return null;

  const proxy = toEmbedProxyUrl(endpoint, playerv2Url);
  if (!proxy) return null;

  // yallashot token endpoint is picky about `fp` format; short alnum tends to work.
  const fpCandidates = (() => {
    const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const pick = (len: number) => {
      let out = "";
      for (let i = 0; i < len; i += 1) out += alpha[Math.floor(Math.random() * alpha.length)];
      return out;
    };
    const browserFp = computePlayerv2CanvasFingerprint();
    return Array.from(new Set([browserFp || "", pick(6), "abc123"].filter(Boolean)));
  })();

  const payloads = [
    ...fpCandidates.map((fp) => new URLSearchParams({ path: tokenPath, fp }).toString()),
    new URLSearchParams({ path: tokenPath }).toString(),
  ];

  for (const payload of payloads) {
    try {
      const res = await fetch(proxy, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "x-embed-proxy-probe": "1",
        },
        body: payload,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch { }

      const data = json as Record<string, unknown> | null;
      const token =
        typeof data?.token === "string" || typeof data?.token === "number"
          ? String(data.token).trim()
          : "";
      const sid =
        typeof data?.session_id === "string" || typeof data?.session_id === "number"
          ? String(data.session_id).trim()
          : "";
      if (token && sid) {
        const payload = { token, session_id: sid } satisfies Playerv2TokenPayload;
        setCachedPlayerv2Token(playerv2Url, tokenPath, payload);
        return payload;
      }

      const errorText = typeof data?.error === "string" ? String(data.error) : "";
      if (pushDiag && errorText) pushDiag(`playerv2 token error: ${errorText}`);
      if (res.status === 403 || /forbidden/i.test(errorText)) {
        pushDiag?.(`playerv2 token blocked status=${res.status}`);
        continue;
      }
      if (res.status === 429) {
        pushDiag?.(`playerv2 token ratelimit status=${res.status}`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") break;
    }
  }

  if (cachedStale) {
    pushDiag?.("playerv2 token stale fallback");
    return cachedStale;
  }
  return null;
}

async function extractPlayerv2TokenizedCandidatesFromHtml(
  html: string,
  playerv2Url: string,
  signal?: AbortSignal,
  pushDiag?: (line: string) => void
) {
  const cfg = extractPlayerv2ConfigFromHtml(html, playerv2Url);
  if (!cfg.paths.length || !cfg.domains.length) return [];

  const out: string[] = [];
  const ts = String(Math.floor(Date.now() / 1000));
  const nonces = buildPlayerv2NonceCandidates();

  for (const path of cfg.paths.slice(0, 4)) {
    const tokenPath = normalizePlayerv2Path(path);
    if (!tokenPath) continue;

    const tokenPayload = await requestPlayerv2TokenFromProxy(playerv2Url, tokenPath, signal, pushDiag);
    if (!tokenPayload) continue;

    const basePath = tokenPath.replace(/\.m3u8$/i, "");
    const pathVariants = Array.from(new Set([basePath, `${basePath}.m3u8`]));

    for (const domain of cfg.domains.slice(0, 4)) {
      for (const pv of pathVariants) {
        let abs = "";
        try {
          abs = new URL(pv.replace(/^\/+/, ""), domain).toString();
        } catch {
          continue;
        }

        for (const nonce of nonces) {
          const q = new URLSearchParams({
            ts,
            nonce,
            token: tokenPayload.token,
            sid: tokenPayload.session_id,
          });
          const proxied = toEmbedProxyUrl(`${abs}?${q.toString()}`, playerv2Url);
          if (proxied) out.push(proxied);
        }
      }
    }
  }

  return dedupeUrls(out);
}

async function resolveCandidatesForServer(
  sourceUrl: string,
  signal: AbortSignal,
  opts?: {
    maxPlayerPages?: number;
    maxDeepCandidates?: number;
    maxPlayerv2Pool?: number;
    playerv2Diag?: (line: string) => void;
    onBatchCandidates?: (
      batch: string[],
      phase: ResolveBatchPhase,
      provenance?: Map<string, Server3CandidateProvenance>
    ) => void;
    parallelChildConcurrency?: number;
    fetchTimeoutMs?: number;
    fetchRetries?: number;
    fetchRetryDelayMs?: number;
    allowSamePathServVariants?: boolean;
    livehdServPreference?: "prefer0" | "all";
    server5Mode?: "fast" | "final";
    server5LandingLimit?: number;
    server5ChannelKeyLimit?: number;
    server5AllowSitemap?: boolean;
    server5SearchTerms?: string[];
  }
): Promise<ResolveCandidatesResult> {
  const maxPlayerPages = opts?.maxPlayerPages ?? 6;
  const maxDeepCandidates = opts?.maxDeepCandidates ?? 8;
  const maxPlayerv2Pool = opts?.maxPlayerv2Pool ?? 6;
  const parallelChildConcurrency = opts?.parallelChildConcurrency ?? RESOLVE_CHILD_CONCURRENCY;
  const fetchTimeoutMs = opts?.fetchTimeoutMs ?? CANDIDATE_PROBE_TIMEOUT_MS;
  const fetchRetries = Math.max(0, Math.floor(opts?.fetchRetries ?? 0));
  const fetchRetryDelayMs = Math.max(0, Math.floor(opts?.fetchRetryDelayMs ?? 180));
  const allowSamePathServVariants = opts?.allowSamePathServVariants ?? false;
  const livehdServPreference = opts?.livehdServPreference ?? "all";
  const server5Mode = opts?.server5Mode ?? "final";
  const server5LandingLimit = Math.max(
    1,
    Math.min(SERVER5_LANDING_LIMIT, Math.floor(opts?.server5LandingLimit ?? SERVER5_LANDING_LIMIT))
  );
  const server5ChannelKeyLimit = Math.max(
    1,
    Math.min(8, Math.floor(opts?.server5ChannelKeyLimit ?? 4))
  );
  const server5AllowSitemap = opts?.server5AllowSitemap ?? true;
  const server5SearchTerms = buildServer5SearchTerms(opts?.server5SearchTerms || []);
  const isServer5Resolution = !!opts?.server5Mode && isLikelyServer5LookupLandingUrl(sourceUrl);
  const server5ResolveDeadlineAt = isServer5Resolution ? Date.now() + SERVER5_RESOLVE_TOTAL_BUDGET_MS : 0;
  const getServer5BudgetRemainingMs = () =>
    isServer5Resolution ? Math.max(0, server5ResolveDeadlineAt - Date.now()) : Number.POSITIVE_INFINITY;
  const getServer5BudgetScopedTimeoutMs = (preferredMs: number, minMs: number) => {
    if (!isServer5Resolution) return preferredMs;
    const remaining = getServer5BudgetRemainingMs();
    if (!Number.isFinite(remaining) || remaining <= minMs + 80) return 0;
    return Math.max(minMs, Math.min(preferredMs, remaining - 80));
  };
  const sourceServ = getServFromUrl(sourceUrl);
  const sourcePathKey = normalizePathKey(sourceUrl);
  const sourceLivehdTv = parseLivehdTvMeta(sourceUrl);
  const sourceRootPathKey = sourceLivehdTv?.pathKey || "";
  const sourceRootServ = normalizeServer3RootServ(sourceLivehdTv?.serv ?? null);
  const provenanceByKey = new Map<string, Server3CandidateProvenance>();

  const keyOfCandidate = (value: string) => canonicalizeUrl(value) || String(value || "").trim().toLowerCase();
  const getKnownProvenanceFromUrl = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return null;

    const keys: Array<string | null> = [canonicalizeUrl(raw)];
    if (isValidHttpUrl(raw)) {
      keys.push(`proxy:${raw.toLowerCase()}`);
      const proxiedSelf = toEmbedProxyUrl(raw, raw);
      if (proxiedSelf) keys.push(canonicalizeUrl(proxiedSelf));
    }

    for (const k of keys) {
      if (!k) continue;
      const found = provenanceByKey.get(k);
      if (found) return found;
    }
    return null;
  };

  const deriveServer3Provenance = (
    candidate: string,
    phase: ResolveBatchPhase
  ): Server3CandidateProvenance | null => {
    if (!sourceLivehdTv) return null;

    const target = candidate.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(candidate) || "" : candidate;
    const directMeta = parseLivehdTvMeta(target);
    if (directMeta) {
      return {
        rootPathKey: directMeta.pathKey || sourceRootPathKey,
        rootServ: normalizeServer3RootServ(directMeta.serv),
        originStage: phase,
      };
    }

    const refUrl = getProxyRefUrlFromCandidate(candidate);
    if (refUrl) {
      const refMeta = parseLivehdTvMeta(refUrl);
      if (refMeta) {
        return {
          rootPathKey: refMeta.pathKey || sourceRootPathKey,
          rootServ: normalizeServer3RootServ(refMeta.serv),
          originStage: phase,
        };
      }
      const knownRef = getKnownProvenanceFromUrl(refUrl);
      if (knownRef) {
        return {
          rootPathKey: knownRef.rootPathKey || sourceRootPathKey,
          rootServ: knownRef.rootServ,
          originStage: phase,
        };
      }
    }

    const knownTarget = getKnownProvenanceFromUrl(target);
    if (knownTarget) {
      return {
        rootPathKey: knownTarget.rootPathKey || sourceRootPathKey,
        rootServ: knownTarget.rootServ,
        originStage: phase,
      };
    }

    return {
      rootPathKey: sourceRootPathKey,
      rootServ: sourceRootServ,
      originStage: phase,
    };
  };

  const storeServer3ProvenanceForUrl = (value: string, next: Server3CandidateProvenance) => {
    if (!sourceLivehdTv || !next) return;
    const raw = String(value || "").trim();
    if (!raw) return;
    const keys = new Set<string>();
    const candidateKey = keyOfCandidate(raw);
    if (candidateKey) keys.add(candidateKey);

    const target = raw.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(raw) || "" : raw;
    if (target && isValidHttpUrl(target)) {
      const canonTarget = canonicalizeUrl(target);
      if (canonTarget) keys.add(canonTarget);
      keys.add(`proxy:${target.toLowerCase()}`);
      const proxiedSelf = toEmbedProxyUrl(target, target);
      const proxiedSelfKey = proxiedSelf ? canonicalizeUrl(proxiedSelf) : null;
      if (proxiedSelfKey) keys.add(proxiedSelfKey);
    }

    const refUrl = getProxyRefUrlFromCandidate(raw);
    if (refUrl && isValidHttpUrl(refUrl)) {
      const canonRef = canonicalizeUrl(refUrl);
      if (canonRef) keys.add(canonRef);
      keys.add(`proxy:${refUrl.toLowerCase()}`);
      const proxiedRef = toEmbedProxyUrl(refUrl, refUrl);
      const proxiedRefKey = proxiedRef ? canonicalizeUrl(proxiedRef) : null;
      if (proxiedRefKey) keys.add(proxiedRefKey);
    }

    for (const key of keys) {
      if (!key) continue;
      const picked = pickBetterServer3Provenance(provenanceByKey.get(key), next);
      provenanceByKey.set(key, picked);
    }
  };

  const annotateBatchProvenance = (batch: string[], phase: ResolveBatchPhase) => {
    const out = new Map<string, Server3CandidateProvenance>();
    if (!sourceLivehdTv || !batch.length) return out;
    for (const candidate of batch) {
      const key = keyOfCandidate(candidate);
      if (!key) continue;
      const next = deriveServer3Provenance(candidate, phase);
      if (!next) continue;
      storeServer3ProvenanceForUrl(candidate, next);
      const picked = pickBetterServer3Provenance(provenanceByKey.get(key), next);
      out.set(key, picked);
    }
    return out;
  };

  const normalizePlayableBatch = (input: string[]) =>
    dedupeUrls(input).filter((url) => {
      const target = url.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(url) || "" : url;
      return isStrongPlayableStreamUrl(target) || isLikelyLivePhpEndpointUrl(target);
    });
  const emitBatch = (batch: string[], phase: ResolveBatchPhase) => {
    const normalized = normalizePlayableBatch(batch);
    if (!normalized.length) return;
    const batchProvenance = annotateBatchProvenance(normalized, phase);
    opts?.onBatchCandidates?.(normalized, phase, batchProvenance);
  };

  const fetchHtml = async (url: string) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= fetchRetries; attempt += 1) {
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1" },
          },
          fetchTimeoutMs,
          signal
        );
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        return { res, ct };
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        lastError = e;
        if (attempt >= fetchRetries || signal.aborted) throw e;
        const delay = fetchRetryDelayMs * (attempt + 1);
        if (delay > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error("resolve-fetch-failed");
  };

  const fetchServer5HtmlPage = async (pageUrl: string, refUrl: string) => {
    const cacheKey = canonicalizeUrl(pageUrl) || String(pageUrl || "").trim().toLowerCase();
    if (!cacheKey) return null as { ok: boolean; ct: string; html: string } | null;
    const cached = getServer5HtmlFetchCacheEntry(cacheKey);
    if (cached) return { ok: cached.ok, ct: cached.ct, html: cached.html };

    const probe = toEmbedProxyUrl(pageUrl, refUrl || pageUrl);
    if (!probe) {
      setServer5HtmlFetchCacheEntry(cacheKey, { ok: false, ct: "", html: "" });
      return null;
    }

    try {
      const pageRes = await fetchHtml(probe);
      const isHtml = pageRes.ct.includes("text/html") || pageRes.ct.includes("application/xhtml+xml");
      let html = "";
      if (isHtml) html = await pageRes.res.text();
      const hasUsefulSignals = /server_lookup\?channel_id|\/(?:yalla|watch)\.php\?id=|\/wp-json\/sns\/v1\/links/i.test(html);
      const ok = isHtml && (!!html.trim() && (pageRes.res.ok || hasUsefulSignals));
      setServer5HtmlFetchCacheEntry(cacheKey, { ok, ct: pageRes.ct, html });
      return { ok, ct: pageRes.ct, html };
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      setServer5HtmlFetchCacheEntry(cacheKey, { ok: false, ct: "", html: "" });
      return null;
    }
  };

  const resolveServer5SiblingLandingUrls = async (landingUrl: string, landingHtml: string) => {
    const sourceId = extractServer5LandingId(landingUrl);
    if (!sourceId) return [landingUrl] as string[];

    const cacheKey = `v3:${sourceId.toLowerCase()}|${server5SearchTerms.join("|").toLowerCase()}`;
    const now = Date.now();
    const cached = server5SiblingDiscoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > now && cached.urls.length > 1) {
      return cached.urls.slice(0, server5LandingLimit);
    }
    if (cached) server5SiblingDiscoveryCache.delete(cacheKey);

    const out: string[] = [];
    const finalize = () => {
      const finalized = dedupeUrls(out).slice(0, server5LandingLimit);
      if (finalized.length > 1) {
        server5SiblingDiscoveryCache.set(cacheKey, { expiresAt: now + SERVER5_SIBLING_DISCOVERY_TTL_MS, urls: finalized });
        trimServer5SiblingDiscoveryCache(now);
      }
      return finalized.length ? finalized : ([landingUrl] as string[]);
    };
    const maxMatchPageScan =
      server5Mode === "fast"
        ? Math.min(3, SERVER5_MATCH_PAGE_SCAN_LIMIT)
        : Math.min(6, SERVER5_MATCH_PAGE_SCAN_LIMIT);
    const seen = new Set<string>();
    const addBatch = (items: string[]) => {
      for (const value of items) {
        const v = String(value || "").trim();
        if (!v || !isLikelyServer5LookupLandingUrl(v)) continue;
        const key = canonicalizeUrl(v);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(v);
        if (out.length >= server5LandingLimit) break;
      }
    };
    const sourceIdNorm = sourceId.toLowerCase().replace(/^cn/, "");
    const candidateMatchPages = new Map<string, { url: string; requireSourceId: boolean }>();
    const addMatchPages = (items: string[], requireSourceId: boolean) => {
      for (const value of items) {
        const v = String(value || "").trim();
        if (!v || !isAnewssportMatchPageUrl(v)) continue;
        const key = canonicalizeUrl(v);
        if (!key) continue;
        const existing = candidateMatchPages.get(key);
        if (existing) {
          if (requireSourceId && !existing.requireSourceId) existing.requireSourceId = true;
          continue;
        }
        candidateMatchPages.set(key, { url: v, requireSourceId });
        if (candidateMatchPages.size >= maxMatchPageScan) break;
      }
    };
    const hasStrictMatchPages = () => {
      for (const entry of candidateMatchPages.values()) {
        if (entry.requireSourceId) return true;
      }
      return false;
    };
    const processMatchPage = async (pageUrl: string, requireSourceId: boolean) => {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        const pageRes = await fetchServer5HtmlPage(pageUrl, pageUrl);
        if (!pageRes?.ok) return;
        const pageHtml = pageRes.html;
        const fromPage = extractServer5LandingUrlsFromHtml(pageHtml, pageUrl);

        const snsEndpoint = extractAnewssportSnsLinksEndpointFromHtml(pageHtml, pageUrl);
        const fromSns: string[] = [];
        if (snsEndpoint) {
          const snsProbe = toEmbedProxyUrl(snsEndpoint, pageUrl);
          if (snsProbe) {
            try {
              const snsRes = await fetchHtml(snsProbe);
              if (snsRes.res.ok) {
                const snsText = await snsRes.res.text();
                fromSns.push(...extractServer5LandingUrlsFromSnsPayload(snsText, pageUrl));
              }
            } catch (e: unknown) {
              if (e instanceof Error && e.name === "AbortError") throw e;
            }
          }
        }

        const mergedPageUrls = dedupeUrls([...fromPage, ...fromSns]);
        const hasSourceId = mergedPageUrls.some((candidateUrl) => {
          const candidateId = extractServer5LandingId(candidateUrl).toLowerCase();
          if (!candidateId) return false;
          return candidateId.replace(/^cn/, "") === sourceIdNorm;
        });
        const hasTeamHit = isServer5PageTeamsMatchSearchTerms(pageHtml, server5SearchTerms);
        opts?.playerv2Diag?.(
          `server5 page merged=${mergedPageUrls.length} source-hit=${hasSourceId ? 1 : 0} team-hit=${hasTeamHit ? 1 : 0}`
        );
        if (requireSourceId && !hasSourceId && !hasTeamHit) return;

        addBatch(mergedPageUrls);
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }
    };

    addBatch([landingUrl]);
    if (landingHtml) addBatch(extractServer5LandingUrlsFromHtml(landingHtml, landingUrl));
    if (server5Mode === "fast") return finalize();
    if (out.length >= server5LandingLimit) {
      return finalize();
    }
    if (getServer5BudgetRemainingMs() <= 260) {
      return finalize();
    }

    const searchUrl = `https://anewssport.fun/?s=${encodeURIComponent(sourceId)}`;
    const searchProbe = toEmbedProxyUrl(searchUrl, searchUrl);
    if (searchProbe) {
      try {
        const searchRes = await fetchHtml(searchProbe);
        if (searchRes.ct.includes("text/html") || searchRes.ct.includes("application/xhtml+xml")) {
          const searchHtml = await searchRes.res.text();
          addMatchPages(extractAnewssportMatchPageUrlsFromHtml(searchHtml, searchUrl), true);
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }
    }

    if ((candidateMatchPages.size < maxMatchPageScan || out.length < Math.min(2, server5LandingLimit)) && server5SearchTerms.length) {
      const teamSearchTerms = server5SearchTerms;
      for (const searchTerm of teamSearchTerms) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (getServer5BudgetRemainingMs() <= 260) break;
        const searchByTeamUrl = `https://anewssport.fun/?s=${encodeURIComponent(searchTerm)}`;
        const searchByTeamProbe = toEmbedProxyUrl(searchByTeamUrl, searchByTeamUrl);
        if (!searchByTeamProbe) continue;
        try {
          const searchByTeamRes = await fetchHtml(searchByTeamProbe);
          if (searchByTeamRes.ct.includes("text/html") || searchByTeamRes.ct.includes("application/xhtml+xml")) {
            const searchByTeamHtml = await searchByTeamRes.res.text();
            addMatchPages(extractAnewssportMatchPageUrlsFromHtml(searchByTeamHtml, searchByTeamUrl), false);
            if (candidateMatchPages.size >= maxMatchPageScan) break;
            if (getServer5BudgetRemainingMs() <= 260) break;
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") throw e;
        }
      }
    }

    if (!hasStrictMatchPages() && server5AllowSitemap) {
      const sitemapIndexUrl = "https://anewssport.fun/wp-sitemap.xml";
      const sitemapIndexProbe = toEmbedProxyUrl(sitemapIndexUrl, sitemapIndexUrl);
      if (sitemapIndexProbe) {
        try {
          const sitemapIndexRes = await fetchHtml(sitemapIndexProbe);
          if (sitemapIndexRes.res.ok) {
            const indexXml = await sitemapIndexRes.res.text();
            const sitemapUrls = extractAnewssportMatchSitemapUrlsFromIndexXml(indexXml);
            for (const sitemapUrl of sitemapUrls.slice(0, 3)) {
              if (signal.aborted) throw new DOMException("aborted", "AbortError");
              if (getServer5BudgetRemainingMs() <= 260) break;
              const sitemapProbe = toEmbedProxyUrl(sitemapUrl, sitemapIndexUrl);
              if (!sitemapProbe) continue;
              try {
                const sitemapRes = await fetchHtml(sitemapProbe);
                if (!sitemapRes.res.ok) continue;
                const sitemapXml = await sitemapRes.res.text();
                addMatchPages(extractAnewssportMatchPageUrlsFromSitemapXml(sitemapXml), true);
                if (candidateMatchPages.size >= maxMatchPageScan) break;
              } catch (e: unknown) {
                if (e instanceof Error && e.name === "AbortError") throw e;
              }
            }
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") throw e;
        }
      }
    }

    const orderedMatchPages = Array.from(candidateMatchPages.values()).sort((a, b) => {
      if (a.requireSourceId === b.requireSourceId) return 0;
      return a.requireSourceId ? -1 : 1;
    });
    const strictCount = orderedMatchPages.filter((entry) => entry.requireSourceId).length;
    opts?.playerv2Diag?.(`server5 siblings pages=${orderedMatchPages.length} strict=${strictCount}`);
    const pagesToScan = orderedMatchPages.slice(0, maxMatchPageScan);
    const scanConcurrency = Math.min(2, pagesToScan.length || 1);
    if (pagesToScan.length) {
      await mapWithConcurrency(pagesToScan, scanConcurrency, async (entry) => {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (getServer5BudgetRemainingMs() <= 200) return;
        if (out.length >= server5LandingLimit) return;
        await processMatchPage(entry.url, entry.requireSourceId);
      });
    }

    return finalize();
  };

  const resolveServer5LookupCandidates = async (pageUrl: string, pageHtml: string) => {
    const isServer5Landing = isLikelyServer5LookupLandingUrl(pageUrl);
    if (
      !isServer5Landing &&
      !/server_lookup\?channel_id|\/(?:yalla|watch)\.php\?id=|\/(?:player\/)?live\d+\.php/i.test(String(pageHtml || ""))
    ) {
      return [] as string[];
    }

    const landingUrls = isServer5Landing
      ? await resolveServer5SiblingLandingUrls(pageUrl, pageHtml)
      : (() => {
          const fromHtml = extractServer5LandingUrlsFromHtml(pageHtml, pageUrl);
          return fromHtml.length ? fromHtml : [pageUrl];
        })();
    const lookupTimeoutPreferredMs =
      server5Mode === "fast"
        ? Math.max(900, Math.min(fetchTimeoutMs, SERVER5_LOOKUP_TIMEOUT_FAST_MS))
        : Math.max(1200, Math.min(fetchTimeoutMs, SERVER5_LOOKUP_TIMEOUT_FINAL_MS));
    const getLookupTimeoutMs = () =>
      getServer5BudgetScopedTimeoutMs(lookupTimeoutPreferredMs, server5Mode === "fast" ? 500 : 700);
    const out: string[] = [];
    let fastStop = false;
    const scopedLandingLimit = server5Mode === "fast" ? Math.min(2, server5LandingLimit) : Math.min(4, server5LandingLimit);

    for (const landingUrl of dedupeUrls(landingUrls).slice(0, scopedLandingLimit)) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (getServer5BudgetRemainingMs() <= 200) break;
      if (server5Mode === "fast" && fastStop) break;
      let landingHtml = landingUrl === pageUrl ? String(pageHtml || "") : "";
      let landingSlot = "";
      try {
        landingSlot = String(new URL(toUnderlyingUrl(landingUrl)).searchParams.get("s5_slot") || "").trim();
      } catch { }
      if (!landingHtml && isLikelyServer5LookupLandingUrl(landingUrl)) {
        try {
          const landingRes = await fetchServer5HtmlPage(landingUrl, landingUrl);
          if (landingRes?.ok) landingHtml = landingRes.html;
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") throw e;
        }
      }

      const landingAuthContext = extractServer5AuthContextFromHtml(landingHtml);
      const landingId = extractServer5LandingId(landingUrl);
      const lookupEndpointCandidates = prioritizeServer5LookupEndpointCandidates(
        buildServer5LookupEndpointCandidates(landingHtml, landingUrl),
        landingUrl,
        server5Mode
      );
      const scopedLookupEndpointCandidates =
        server5Mode === "fast" ? lookupEndpointCandidates.slice(0, 1) : lookupEndpointCandidates.slice(0, 2);
      if (!scopedLookupEndpointCandidates.length) continue;
      const explicitChannelKeys = extractServer5ChannelKeyCandidates(landingUrl, landingHtml)
        .map((value) => sanitizeServer5ChannelKey(value))
        .filter(Boolean);
      const explicitChannelKeysSet = new Set(explicitChannelKeys.map((value) => value.toLowerCase()));
      const derivedChannelFromLandingId = (() => {
        const id = sanitizeServer5ChannelKey(landingId);
        if (!id) return "";
        if (/^cn[a-z0-9_-]{3,64}$/i.test(id)) return sanitizeServer5ChannelKey(id.slice(2));
        if (/^\d{2,8}$/.test(id)) return sanitizeServer5ChannelKey(`yallalive${id}`);
        return id;
      })();
      const derivedLower = derivedChannelFromLandingId.toLowerCase();
      const authLower = landingAuthContext?.channelKey.toLowerCase() || "";
      const channelKeyLimit = server5Mode === "fast" ? Math.min(1, server5ChannelKeyLimit) : Math.min(2, server5ChannelKeyLimit);
      const channelKeys = Array.from(
        new Set(
          [landingAuthContext?.channelKey || "", derivedChannelFromLandingId, ...explicitChannelKeys]
            .map((value) => sanitizeServer5ChannelKey(value))
            .filter(Boolean)
        )
      )
        .filter((value) => {
          if (!landingAuthContext) return true;
          const lower = value.toLowerCase();
          if (!lower.startsWith("cnpremium")) return true;
          return lower === landingAuthContext.channelKey.toLowerCase() || explicitChannelKeysSet.has(lower);
        })
        .sort((a, b) => {
          const score = (value: string) => {
            const lower = value.toLowerCase();
            let total = 0;
            if (authLower && lower === authLower) total += 120;
            if (derivedLower && lower === derivedLower) total += 80;
            if (lower.startsWith("yallalive")) total += 70;
            else if (lower.startsWith("premium")) total += 45;
            else if (lower.startsWith("cnpremium")) total -= 20;
            if (/^\d{2,8}$/.test(lower)) total -= 25;
            return total;
          };
          return score(b) - score(a);
        })
        .slice(0, channelKeyLimit);
      if (!channelKeys.length) continue;
      for (const channelKey of channelKeys) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (getServer5BudgetRemainingMs() <= 200) break;
        let channelProduced = false;
        for (const lookupEndpointUrl of scopedLookupEndpointCandidates) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          const lookupTimeoutMs = getLookupTimeoutMs();
          if (lookupTimeoutMs <= 0) {
            fastStop = true;
            break;
          }
          const missCacheTtlMs = (() => {
            try {
              const host = new URL(lookupEndpointUrl).hostname.toLowerCase();
              if (host === "dvalna.ru" || host.endsWith(".dvalna.ru")) {
                return server5Mode === "fast" ? 20_000 : 45_000;
              }
            } catch { }
            return SERVER5_LOOKUP_MISS_CACHE_TTL_MS;
          })();
          const lookupCacheKey = buildServer5LookupCacheKey(landingId, channelKey, lookupEndpointUrl);
          let serverKey = getServer5LookupCacheEntry(lookupCacheKey);
          if (serverKey === undefined) {
            const lookupUrl = `${lookupEndpointUrl}?channel_id=${encodeURIComponent(channelKey)}`;
            const probe = toEmbedProxyUrl(lookupUrl, landingUrl);
            if (!probe) continue;
            let lookupPromise = server5LookupInFlight.get(lookupCacheKey);
            if (!lookupPromise) {
              lookupPromise = (async () => {
                try {
                  const lookupRes = await fetchWithTimeout(
                    probe,
                    {
                      method: "GET",
                      cache: "no-store",
                      credentials: "same-origin",
                      headers: { "x-embed-proxy-probe": "1" },
                    },
                    lookupTimeoutMs
                  );
                  if (!lookupRes.ok) {
                    setServer5LookupCacheEntry(lookupCacheKey, null, missCacheTtlMs);
                    return null;
                  }
                  const lookupText = await lookupRes.text();
                  const extractedServerKey = extractServer5LookupServerKey(lookupText);
                  if (!extractedServerKey) {
                    setServer5LookupCacheEntry(lookupCacheKey, null, missCacheTtlMs);
                    return null;
                  }
                  setServer5LookupCacheEntry(lookupCacheKey, extractedServerKey, SERVER5_LOOKUP_SUCCESS_CACHE_TTL_MS);
                  return extractedServerKey;
                } catch {
                  setServer5LookupCacheEntry(lookupCacheKey, null, missCacheTtlMs);
                  return null;
                } finally {
                  server5LookupInFlight.delete(lookupCacheKey);
                }
              })();
              server5LookupInFlight.set(lookupCacheKey, lookupPromise);
            }
            if (!lookupPromise) continue;
            serverKey = await lookupPromise;
          }
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          if (!serverKey) continue;

          const manifests = buildServer5ManifestUrls(serverKey, channelKey, lookupEndpointUrl, server5Mode);
          const authForChannel =
            landingAuthContext && landingAuthContext.channelKey.toLowerCase() === channelKey.toLowerCase()
              ? landingAuthContext
              : null;
          for (const manifest of manifests) {
            let finalManifest = manifest;
            if (landingSlot) {
              try {
                const tagged = new URL(finalManifest);
                tagged.searchParams.set("s5_slot", landingSlot);
                finalManifest = tagged.toString();
              } catch { }
            }
            let proxied = toEmbedProxyUrl(finalManifest, landingUrl);
            if (!proxied) continue;
            if (authForChannel) {
              proxied = attachServer5AuthContextToProxyUrl(proxied, authForChannel);
            }
            out.push(proxied);
            channelProduced = true;
            if (server5Mode === "fast") {
              const minFastCandidates = landingSlot === "2" ? SERVER5_FAST_MIN_RESOLVED_CANDIDATES : 2;
              if (out.length >= minFastCandidates) {
                fastStop = true;
                break;
              }
            }
          }
          if (server5Mode !== "fast" && out.length >= SERVER5_FAST_MIN_RESOLVED_CANDIDATES + 1) break;
          if (server5Mode === "fast" && channelProduced) break;
          if (server5Mode === "fast" && fastStop) break;
        }
        if (server5Mode !== "fast" && out.length >= SERVER5_FAST_MIN_RESOLVED_CANDIDATES + 1) break;
        if (server5Mode === "fast" && fastStop) break;
      }
      if (server5Mode === "fast" && fastStop) break;
    }

    return dedupeUrls(out).filter((value) => isServer5AuthReadyCandidate(value));
  };

  if (isStrongPlayableStreamUrl(sourceUrl) || isLikelyLivePhpEndpointUrl(sourceUrl)) {
    const one = toEmbedProxyUrl(sourceUrl, sourceUrl);
    if (one) emitBatch([one], "fast");
    return { candidates: one ? [one] : [], provenanceByKey };
  }

  const probe = toEmbedProxyUrl(sourceUrl, sourceUrl);
  if (!probe) return { candidates: [], provenanceByKey };

  const first = await fetchHtml(probe);
  if (HLS_CT.some((x) => first.ct.includes(x))) {
    emitBatch([probe], "fast");
    return { candidates: [probe], provenanceByKey };
  }

  if (!first.ct.includes("text/html") && !first.ct.includes("application/xhtml+xml")) {
    const server5LookupFromNonHtml = await resolveServer5LookupCandidates(sourceUrl, "");
    if (server5LookupFromNonHtml.length) {
      emitBatch(server5LookupFromNonHtml, "fast");
      return { candidates: normalizePlayableBatch(server5LookupFromNonHtml), provenanceByKey };
    }
    return { candidates: [], provenanceByKey };
  }

  const html = await first.res.text();
  const directAccessBlocked = isDirectAccessDeniedHtml(first.res.status, html);
  const yallashootFallback =
    directAccessBlocked && !isServer5Resolution ? buildYallashootDirectHlsFallbackCandidates(sourceUrl) : [];
  const primaryList = extractPlayableCandidatesFromProxyHtml(html, sourceUrl);
  const rollingPrimary = extractRollingHlsCandidatesFromHtml(html, sourceUrl);
  const server5LookupPrimary = await resolveServer5LookupCandidates(sourceUrl, html);
  const fastPrimary = [...yallashootFallback, ...rollingPrimary, ...primaryList, ...server5LookupPrimary];
  if (isServer5Resolution) {
    const server5Scoped = dedupeUrls(fastPrimary).filter((value) => isServer5AuthReadyCandidate(value));
    emitBatch(server5Scoped, "fast");
    return { candidates: normalizePlayableBatch(server5Scoped), provenanceByKey };
  }
  emitBatch(fastPrimary, "fast");
  if (directAccessBlocked && yallashootFallback.length) {
    return { candidates: normalizePlayableBatch(fastPrimary), provenanceByKey };
  }

  // For playerv2 sources we keep resolution lightweight to avoid upstream anti-bot/rate-limit bans.
  // We employ a "Speculative Race" strategy:
  // 1. Guess the token path from the URL params (e.g. ?id=ch1 -> ch1.m3u8).
  // 2. Fire off a token request IMMEDIATELY (speculation).
  // 3. Simultaneously fetch the HTML page (slow path).
  // If speculation hits, we get the stream in <1s. If it misses, we fall back to the HTML parse.
  if (isPlayerv2LikeUrl(sourceUrl) || PLAYERV2_CONFIG_RE.test(html)) {
    const tokenized: string[] = [];

    // SPECULATION: Try to guess the token path and fetch it parallel to parsing
    const speculativePath = guessPlayerv2TokenPath(sourceUrl);
    if (speculativePath) {
      opts?.playerv2Diag?.(`playerv2 speculating path: ${speculativePath}`);
      try {
        // We do this blindly without waiting for HTML. If it fails, no harm done.
        const specToken = await requestPlayerv2TokenFromProxy(sourceUrl, speculativePath, signal, opts?.playerv2Diag);
        if (specToken) {
          const ts = String(Math.floor(Date.now() / 1000));
          const nonces = buildPlayerv2NonceCandidates();
          // Construct candidate immediately
          // We assume standard live-hd domain structure or use the origin
          const origin = new URL(sourceUrl).origin;
          const variants = [speculativePath, speculativePath.replace(".m3u8", "")];
          for (const v of variants) {
            for (const nonce of nonces) {
              const q = new URLSearchParams({ ts, nonce, token: specToken.token, sid: specToken.session_id });
              // Try both relative to origin and relative to /hls/
              const candidate1 = toEmbedProxyUrl(`${origin}/${v}?${q}`, sourceUrl);
              if (candidate1) tokenized.push(candidate1);
              const candidate2 = toEmbedProxyUrl(`${origin}/hls/${v}?${q}`, sourceUrl);
              if (candidate2) tokenized.push(candidate2);
            }
          }
          if (tokenized.length) {
            opts?.playerv2Diag?.(`playerv2 speculation HIT +${tokenized.length}`);
            // We can return early if we are confident, or let the HTML parse happen as backup.
            // For speed, we emit immediately.
            emitBatch(tokenized, "token");
          }
        }
      } catch (e) {
        opts?.playerv2Diag?.(`playerv2 speculation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // SLOW PATH: Parse HTML (Safety Net)
    // Only run this if speculation didn't produce enough candidates, or run it anyway for robustness?
    // Running it anyway ensures we don't miss obscure configurations.
    if (tokenized.length < 1) {
      try {
        const fromHtml = await extractPlayerv2TokenizedCandidatesFromHtml(
          html,
          sourceUrl,
          signal,
          opts?.playerv2Diag
        );
        if (fromHtml.length) {
          tokenized.push(...fromHtml);
          emitBatch(fromHtml, "token");
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }
    }

    return {
      candidates: normalizePlayableBatch([...rollingPrimary, ...primaryList, ...server5LookupPrimary, ...tokenized]),
      provenanceByKey,
    };
  }

  const isSameServerVariantPage = (value: string) => {
    const target = value.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(value) || "" : value;
    if (!target || !isValidHttpUrl(target)) return false;

    const targetServ = getServFromUrl(target);
    const targetLivehdTv = parseLivehdTvMeta(target);
    if (
      livehdServPreference === "prefer0" &&
      sourceLivehdTv &&
      targetLivehdTv &&
      sourceLivehdTv.pathKey === targetLivehdTv.pathKey
    ) {
      // Keep sibling serv variants available, but ordering will strongly prefer serv=0.
      if (targetLivehdTv.serv !== null && targetLivehdTv.serv !== 0 && targetLivehdTv.serv !== 1) return false;
    }
    if (sourceServ !== null) {
      // LIVEHD TV pages can switch between serv=0/serv=1 for the same channel path.
      // We allow both variants here, then ranking decides priority.
      if (
        sourceLivehdTv &&
        targetLivehdTv &&
        sourceLivehdTv.pathKey === targetLivehdTv.pathKey
      ) {
        return true;
      }
      if (targetServ !== null && targetServ !== sourceServ) return false;
      return true;
    }

    if (!allowSamePathServVariants && targetServ !== null && normalizePathKey(target) === sourcePathKey) {
      return false;
    }
    return true;
  };
  const playerPages = dedupeUrls(extractPlayerPageCandidatesFromProxyHtml(html, sourceUrl));
  const maxPlayerCrawlDepth = 5;
  const maxCrawledPlayerPages = Math.max(maxPlayerPages, maxPlayerPages * 6);
  const deepList: string[] = [];
  const rollingDeepList: string[] = [];
  const playerv2HtmlPool: Array<{ pageUrl: string; html: string }> = [];
  playerv2HtmlPool.push({ pageUrl: sourceUrl, html });
  type ChildResolveResult = {
    deep: string[];
    rolling: string[];
    playerv2: { pageUrl: string; html: string } | null;
    playable: string[];
    nextPlayerPages: string[];
    baseUrl: string;
  };
  type PlayerQueueItem = { pageUrl: string; depth: number; parentRef: string };
  const emptyChildResult: ChildResolveResult = {
    deep: [],
    rolling: [],
    playerv2: null,
    playable: [],
    nextPlayerPages: [],
    baseUrl: "",
  };

  const enqueuePlayerPages = (
    queue: PlayerQueueItem[],
    visited: Set<string>,
    candidates: string[],
    depth: number,
    parentRef: string
  ) => {
    for (const candidate of candidates) {
      if (!isSameServerVariantPage(candidate)) continue;
      if (sourceLivehdTv) {
        const next = deriveServer3Provenance(candidate, "deep");
        if (next) storeServer3ProvenanceForUrl(candidate, next);
      }
      const key = canonicalizeUrl(candidate) || String(candidate || "").trim().toLowerCase();
      if (!key || visited.has(key)) continue;
      visited.add(key);
      queue.push({ pageUrl: candidate, depth, parentRef });
      if (queue.length >= maxCrawledPlayerPages * 2) break;
    }
  };

  const analyzePlayerPage = async (item: PlayerQueueItem): Promise<ChildResolveResult> => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const pageTargetUrl = item.pageUrl.startsWith("/api/embed-proxy?")
        ? getProxyTargetUrl(item.pageUrl) || ""
        : item.pageUrl;
      const pageBaseUrl = isValidHttpUrl(pageTargetUrl) ? pageTargetUrl : item.parentRef;
      if (sourceLivehdTv) {
        const itemProvenance = deriveServer3Provenance(item.pageUrl, "deep");
        if (itemProvenance) {
          storeServer3ProvenanceForUrl(item.pageUrl, itemProvenance);
          if (pageBaseUrl && isValidHttpUrl(pageBaseUrl)) {
            storeServer3ProvenanceForUrl(pageBaseUrl, itemProvenance);
          }
        }
      }
      const childProbe = item.pageUrl.startsWith("/api/embed-proxy?")
        ? item.pageUrl
        : toEmbedProxyUrl(item.pageUrl, item.parentRef || sourceUrl);
      if (!childProbe) return { ...emptyChildResult, baseUrl: pageBaseUrl };

      const child = await fetchHtml(childProbe);
      if (HLS_CT.some((x) => child.ct.includes(x))) {
        return {
          deep: [childProbe],
          rolling: [],
          playerv2: null,
          playable: [childProbe],
          nextPlayerPages: [],
          baseUrl: pageBaseUrl,
        };
      }

      if (!child.ct.includes("text/html") && !child.ct.includes("application/xhtml+xml")) {
        return { ...emptyChildResult, baseUrl: pageBaseUrl };
      }

      const childHtml = await child.res.text();
      const extractionBaseUrl = pageBaseUrl || sourceUrl;
      const resolveEasybroadcastEventCandidates = async (eventPageUrl: string) => {
        if (!isEasybroadcastEventPageUrl(eventPageUrl)) return [] as string[];
        const meta = getEasybroadcastEventMeta(eventPageUrl);
        if (!meta?.apiUrl) return [] as string[];

        const eventApiProbe = toEmbedProxyUrl(meta.apiUrl, eventPageUrl);
        if (!eventApiProbe) return [] as string[];

        let eventApiText = "";
        try {
          const eventRes = await fetchHtml(eventApiProbe);
          if (!eventRes?.res?.ok) return [] as string[];
          eventApiText = await eventRes.res.text();
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") throw e;
          return [] as string[];
        }

        let payload: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(eventApiText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          return [] as string[];
        }
        if (!payload) return [] as string[];

        const baseStreamsAll = dedupeUrls(
          [String(payload.stream || "").trim(), String(payload.stream_no_timeshift || "").trim()].filter((v) =>
            isValidHttpUrl(v)
          )
        );
        const preferredStream = baseStreamsAll[0] || "";
        if (!preferredStream) return [] as string[];
        const baseStreams = [preferredStream];

        const tokenRequired = Boolean(payload.token_authentication);
        const out: string[] = [];
        for (const streamUrl of baseStreams) {
          let finalStreamUrl = streamUrl;
          if (tokenRequired && !hasEasybroadcastTokenQuery(finalStreamUrl)) {
            const tokenEndpoint = `https://token.easybroadcast.io/all?url=${encodeURIComponent(streamUrl)}`;
            const tokenProbe = toEmbedProxyUrl(tokenEndpoint, eventPageUrl);
            if (tokenProbe) {
              try {
                const tokenRes = await fetchHtml(tokenProbe);
                if (tokenRes?.res?.ok) {
                  const tokenBody = await tokenRes.res.text();
                  const tokenQuery = parseEasybroadcastTokenQuery(tokenBody);
                  if (tokenQuery) {
                    finalStreamUrl = appendQueryToUrl(streamUrl, tokenQuery);
                  }
                }
              } catch (e: unknown) {
                if (e instanceof Error && e.name === "AbortError") throw e;
              }
            }
          }

          if (!isStrongPlayableStreamUrl(finalStreamUrl)) continue;
          const proxied = toEmbedProxyUrl(finalStreamUrl, eventPageUrl);
          if (proxied) out.push(proxied);
        }

        return dedupeUrls(out);
      };

      const easybroadcastList = await resolveEasybroadcastEventCandidates(extractionBaseUrl);
      const server5LookupList = await resolveServer5LookupCandidates(extractionBaseUrl, childHtml);
      const childList = extractPlayableCandidatesFromProxyHtml(childHtml, extractionBaseUrl);
      const childRolling = extractRollingHlsCandidatesFromHtml(childHtml, extractionBaseUrl);
      const nextPlayerPages = extractPlayerPageCandidatesFromProxyHtml(childHtml, extractionBaseUrl);
      return {
        deep: [...easybroadcastList, ...server5LookupList, ...childList],
        rolling: childRolling,
        playerv2: pageBaseUrl && isValidHttpUrl(pageBaseUrl) ? { pageUrl: pageBaseUrl, html: childHtml } : null,
        playable: [...easybroadcastList, ...server5LookupList, ...childRolling, ...childList],
        nextPlayerPages,
        baseUrl: pageBaseUrl,
      };
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      return { ...emptyChildResult, baseUrl: item.parentRef };
    }
  };

  const queue: PlayerQueueItem[] = [];
  const visitedPlayerPages = new Set<string>();
  enqueuePlayerPages(queue, visitedPlayerPages, playerPages.slice(0, maxPlayerPages), 1, sourceUrl);

  let crawledPages = 0;
  while (queue.length && crawledPages < maxCrawledPlayerPages) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const remaining = maxCrawledPlayerPages - crawledPages;
    const batchSize = Math.min(parallelChildConcurrency, remaining, queue.length);
    if (batchSize <= 0) break;
    const batch = queue.splice(0, batchSize);
    const batchResults = await mapWithConcurrency(
      batch,
      Math.min(parallelChildConcurrency, batch.length),
      async (item): Promise<{ item: PlayerQueueItem; result: ChildResolveResult }> => {
        const result = await analyzePlayerPage(item);
        return { item, result };
      }
    );
    crawledPages += batch.length;

    for (const { item, result } of batchResults) {
      if (signal.aborted) break;
      if (result.playerv2) playerv2HtmlPool.push(result.playerv2);
      if (result.rolling.length) rollingDeepList.push(...result.rolling);
      if (result.deep.length && deepList.length < maxDeepCandidates) {
        const remainingDeep = maxDeepCandidates - deepList.length;
        deepList.push(...result.deep.slice(0, remainingDeep));
      }
      emitBatch(result.playable, "deep");

      if (item.depth >= maxPlayerCrawlDepth || !result.nextPlayerPages.length) continue;
      const nextParentRef =
        result.baseUrl && isValidHttpUrl(result.baseUrl) ? result.baseUrl : item.parentRef || sourceUrl;
      enqueuePlayerPages(queue, visitedPlayerPages, result.nextPlayerPages, item.depth + 1, nextParentRef);
    }
  }

  const playerv2List: string[] = [];
  const playerv2PoolSeen = new Set<string>();
  const playerv2Pool = playerv2HtmlPool.filter((item) => {
    const pageUrl = item.pageUrl.startsWith("/api/embed-proxy?")
      ? getProxyTargetUrl(item.pageUrl) || item.pageUrl
      : item.pageUrl;
    const key = canonicalizeUrl(pageUrl) || String(pageUrl || "").trim().toLowerCase();
    if (!key || playerv2PoolSeen.has(key)) return false;
    playerv2PoolSeen.add(key);
    return true;
  });
  const playerv2Results = await mapWithConcurrency(
    playerv2Pool.slice(0, maxPlayerv2Pool),
    Math.min(parallelChildConcurrency, 3),
    async (item): Promise<string[]> => {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const pageUrl = item.pageUrl.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(item.pageUrl) || "" : item.pageUrl;
      if (!pageUrl || !isValidHttpUrl(pageUrl)) return [];
      if (!/\/playerv2\.php/i.test(pageUrl) && !PLAYERV2_CONFIG_RE.test(item.html)) return [];
      try {
        return await extractPlayerv2TokenizedCandidatesFromHtml(
          item.html,
          pageUrl,
          signal,
          opts?.playerv2Diag
        );
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        return [];
      }
    }
  );
  for (const built of playerv2Results) {
    if (!built.length) continue;
    playerv2List.push(...built);
    emitBatch(built, "token");
  }

  return {
    candidates: normalizePlayableBatch([...rollingPrimary, ...primaryList, ...rollingDeepList, ...deepList, ...playerv2List]),
    provenanceByKey,
  };
}

async function probeHlsCandidateInternal(candidateUrl: string, opts?: ProbeHlsOptions) {
  const timeoutMs = opts?.timeoutMs ?? CANDIDATE_PROBE_TIMEOUT_MS;
  const maxChildChecks = opts?.maxChildChecks ?? 3;
  const pushDiag = opts?.pushDiag;
  const signal = opts?.signal;
  const server5AuthHeaders = buildServer5ProxyAuthHeadersFromCandidate(candidateUrl);
  const isServer5Candidate = isServer5StackCandidate(candidateUrl);
  const probeRangeHeaderValue = isServer5Candidate ? "bytes=0-4095" : "bytes=0-1024";
  const decodeServer5NumericManifest = (rawManifest: string, ctx: "root" | "child") => {
    const text = String(rawManifest || "").trim();
    if (!isServer5Candidate || !text || /^\s*#EXTM3U/m.test(text)) return rawManifest;
    if (!/^\d{1,3}(?:\s+\d{1,3}){24,}$/.test(text)) return rawManifest;

    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 25) return rawManifest;
    const bytes = new Uint8Array(parts.length);
    for (let i = 0; i < parts.length; i += 1) {
      const n = Number.parseInt(parts[i], 10);
      if (!Number.isFinite(n) || n < 0 || n > 255) return rawManifest;
      bytes[i] = n;
    }

    const decoded = new TextDecoder("utf-8").decode(bytes).trim();
    if (!/^\s*#EXTM3U/m.test(decoded)) return rawManifest;
    const hasMediaLine = decoded.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return !!trimmed && !trimmed.startsWith("#");
    });
    if (!hasMediaLine) return rawManifest;
    pushDiag?.(`probe server5 numeric-manifest decoded ctx=${ctx} bytes=${bytes.byteLength}`);
    return decoded;
  };
  const looksLikeServer5PlayableSegment = async (response: Response) => {
    if (!response.ok) return false;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const contentRange = String(response.headers.get("content-range") || "").trim();
    const isPartial = response.status === 206 || !!contentRange;
    const minBytes = isPartial ? 256 : 4096;
    const contentLength = Number.parseInt(String(response.headers.get("content-length") || "0"), 10);
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/json") ||
      contentType.includes("text/json") ||
      contentType.includes("javascript") ||
      contentType.includes("xml")
    ) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-reject reason=text-ct status=${response.status} bytes=${Number.isFinite(contentLength) ? contentLength : 0}`);
      }
      return false;
    }
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength < minBytes) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-reject reason=small-content-length status=${response.status} bytes=${contentLength}`);
      }
      return false;
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength < minBytes) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-reject reason=small-bytes status=${response.status} bytes=${bytes.byteLength || 0}`);
      }
      return false;
    }
    const probeText = new TextDecoder("utf-8").decode(bytes.slice(0, Math.min(120, bytes.byteLength))).trim().toLowerCase();
    if (!probeText) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-ok status=${response.status} bytes=${bytes.byteLength}`);
      }
      return true;
    }
    if (probeText.startsWith("#extm3u")) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-reject reason=playlist-payload status=${response.status} bytes=${bytes.byteLength}`);
      }
      return false;
    }
    if (
      probeText.startsWith("<!doctype") ||
      probeText.startsWith("<html") ||
      probeText.startsWith("<script") ||
      probeText.startsWith("<?xml") ||
      probeText.startsWith("{")
    ) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-reject reason=text-payload status=${response.status} bytes=${bytes.byteLength}`);
      }
      return false;
    }
    const looksLikeCssOrJsPayload =
      probeText.startsWith("@import") ||
      probeText.includes("url(") ||
      probeText.startsWith("/*") ||
      probeText.startsWith("//") ||
      probeText.startsWith("var ") ||
      probeText.startsWith("const ") ||
      probeText.startsWith("let ") ||
      probeText.startsWith("function ") ||
      probeText.startsWith("export ") ||
      probeText.startsWith("import ");
    if (looksLikeCssOrJsPayload) {
      if (isServer5Candidate && isPartial) {
        pushDiag?.(`probe server5 partial-reject reason=text-css-js status=${response.status} bytes=${bytes.byteLength}`);
      }
      return false;
    }
    if (isServer5Candidate && isPartial) {
      pushDiag?.(`probe server5 partial-ok status=${response.status} bytes=${bytes.byteLength}`);
    }
    return true;
  };
  const verifyServer5ManifestKeys = async (manifestText: string, parentCandidateUrl: string) => {
    if (!isServer5Candidate) return true;
    const keyUris = extractManifestKeyUris(manifestText, 2);
    if (!keyUris.length) return true;

    for (const keyUri of keyUris) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const keyProxy = toPlayableProxyFromManifestLine(keyUri, parentCandidateUrl);
      if (!keyProxy) return false;
      const keyRes = await fetchWithTimeout(
        keyProxy,
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "x-embed-proxy-probe": "1", ...server5AuthHeaders },
        },
        timeoutMs,
        signal
      );
      if (!keyRes.ok) return false;
      const keyBytes = await keyRes.arrayBuffer();
      if (keyBytes.byteLength !== 16) return false;
    }
    return true;
  };
  const probeServer5ChildReachability = async (manifestText: string, parentCandidateUrl: string) => {
    const nestedLines = extractManifestMediaUris(manifestText, maxChildChecks);
    if (!nestedLines.length) return false;

    for (const nestedLine of nestedLines) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const nestedProxy = toPlayableProxyFromManifestLine(nestedLine, parentCandidateUrl);
      if (!nestedProxy) continue;
      const nestedLooksLikeManifest =
        /\.m3u8(?:$|[?#])/i.test(nestedLine) || /(?:^|\/)(?:index|master|playlist)\b/i.test(nestedLine.toLowerCase());
      if (nestedLooksLikeManifest) continue;

      try {
        const nestedGet = await fetchWithTimeout(
          nestedProxy,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1", range: probeRangeHeaderValue, ...server5AuthHeaders },
          },
          timeoutMs,
          signal
        );
        if (await looksLikeServer5PlayableSegment(nestedGet)) return true;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }
    }

    return false;
  };

  try {
    const manifestRes = await fetchWithTimeout(
      candidateUrl,
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-embed-proxy-probe": "1", ...server5AuthHeaders },
      },
      timeoutMs,
      signal
    );

    if (!manifestRes.ok) {
      pushDiag?.(`probe manifest failed status=${manifestRes.status}`);
      return false;
    }

    const contentType = (manifestRes.headers.get("content-type") || "").toLowerCase();
    let manifestText = await manifestRes.text();
    manifestText = decodeServer5NumericManifest(manifestText, "root");
    const hasExtM3u = /^\s*#EXTM3U/m.test(manifestText);
    if (!contentTypeLooksLikeHls(contentType) && !hasExtM3u) {
      pushDiag?.(`probe not-hls ct=${contentType}`);
      return false;
    }

    if (!(await verifyServer5ManifestKeys(manifestText, candidateUrl))) {
      pushDiag?.("probe server5 key-check failed");
      return false;
    }

    const childLines = extractManifestMediaUris(manifestText, maxChildChecks);
    if (!childLines.length) {
      if (isServer5Candidate) pushDiag?.("probe server5 no child lines");
      return !isServer5Candidate;
    }

    for (const childLine of childLines) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const childProxy = toPlayableProxyFromManifestLine(childLine, candidateUrl);
      if (!childProxy) continue;
      const childLooksLikeManifest =
        /\.m3u8(?:$|[?#])/i.test(childLine) || /(?:^|\/)(?:index|master|playlist)\b/i.test(childLine.toLowerCase());

      try {
        const headRes = await fetchWithTimeout(
          childProxy,
          {
            method: "HEAD",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1", ...server5AuthHeaders },
          },
          timeoutMs,
          signal
        );
        if (headRes.ok && !isServer5Candidate && !childLooksLikeManifest) return true;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }

      if (isServer5Candidate && childLooksLikeManifest) {
        try {
          const childManifestRes = await fetchWithTimeout(
            childProxy,
            {
              method: "GET",
              cache: "no-store",
              credentials: "same-origin",
              headers: { "x-embed-proxy-probe": "1", ...server5AuthHeaders },
            },
            timeoutMs,
            signal
          );
          if (childManifestRes.ok) {
            let childText = await childManifestRes.text();
            childText = decodeServer5NumericManifest(childText, "child");
            const childHasExtM3u = /^\s*#EXTM3U/m.test(childText);
            if (
              childHasExtM3u &&
              (await verifyServer5ManifestKeys(childText, childProxy)) &&
              (await probeServer5ChildReachability(childText, childProxy))
            ) {
              return true;
            }
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") throw e;
        }
      }

      try {
        const getRes = await fetchWithTimeout(
          childProxy,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1", range: probeRangeHeaderValue, ...server5AuthHeaders },
          },
          timeoutMs,
          signal
        );
        if (isServer5Candidate && !childLooksLikeManifest) {
          if (await looksLikeServer5PlayableSegment(getRes)) return true;
          continue;
        }
        if (getRes.ok) return true;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }
    }

    if (!isServer5Candidate && hasExtM3u) {
      pushDiag?.("probe soft-pass manifest");
      return true;
    }

    pushDiag?.("probe no reachable child line");
    return false;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    pushDiag?.(`probe error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function probeHlsCandidate(candidateUrl: string, opts?: ProbeHlsOptions) {
  const isServer5Candidate = isServer5StackCandidate(candidateUrl);
  if (!isServer5Candidate) {
    return probeHlsCandidateInternal(candidateUrl, opts);
  }
  const cacheKey = buildServer5ProbeCacheKey(candidateUrl);
  if (!cacheKey) {
    return probeHlsCandidateInternal(candidateUrl, opts);
  }
  const cached = getServer5ProbeCached(cacheKey);
  if (cached !== null) {
    opts?.pushDiag?.(`probe cache ${cached ? "hit" : "miss"}`);
    return cached;
  }
  const inFlight = server5ProbeInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  let localPromise: Promise<boolean> | null = null;
  localPromise = (async () => {
    try {
      const ok = await probeHlsCandidateInternal(candidateUrl, opts);
      setServer5ProbeCached(cacheKey, ok);
      return ok;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      setServer5ProbeCached(cacheKey, false);
      return false;
    } finally {
      if (server5ProbeInFlight.get(cacheKey) === localPromise) {
        server5ProbeInFlight.delete(cacheKey);
      }
    }
  })();
  server5ProbeInFlight.set(cacheKey, localPromise);
  return localPromise;
}

async function filterPlayableCandidates(input: string[], opts?: FilterPlayableOptions) {
  const limit = opts?.maxChecks && opts.maxChecks > 0 ? opts.maxChecks : input.length;
  const scoped = input.slice(0, limit);
  if (!scoped.length) return [];
  const concurrency = opts?.concurrency ?? PROBE_CONCURRENCY;
  const checks = await mapWithConcurrency(scoped, concurrency, async (candidate) => {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const ok = await probeHlsCandidate(candidate, opts);
    return { candidate, ok };
  });
  return checks.filter((x) => x.ok).map((x) => x.candidate);
}

async function expandCandidatesWithManifestVariants(
  input: string[],
  opts?: ProbeHlsOptions & { maxParents?: number; maxVariantsPerParent?: number; concurrency?: number }
) {
  const base = dedupeUrls(input || []);
  if (!base.length) return [];

  const signal = opts?.signal;
  const timeoutMs = opts?.timeoutMs ?? CANDIDATE_PROBE_TIMEOUT_MS;
  const maxParents = opts?.maxParents && opts.maxParents > 0 ? opts.maxParents : 8;
  const maxVariantsPerParent =
    opts?.maxVariantsPerParent && opts.maxVariantsPerParent > 0 ? opts.maxVariantsPerParent : 12;
  const concurrency = opts?.concurrency ?? EXPAND_VARIANTS_CONCURRENCY;
  const extrasByParent = await mapWithConcurrency(
    base.slice(0, maxParents),
    concurrency,
    async (candidate): Promise<string[]> => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      try {
        const res = await fetchWithTimeout(
          candidate,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1" },
          },
          timeoutMs,
          signal
        );
        if (!res.ok) return [];

        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        const text = await res.text();
        const hasExtM3u = /^\s*#EXTM3U/m.test(text);
        if (!contentTypeLooksLikeHls(contentType) && !hasExtM3u) return [];

        const local: string[] = [];
        const lines = extractManifestMediaUris(text, maxVariantsPerParent);
        for (const line of lines) {
          const item = String(line || "").trim();
          if (!item) continue;
          if (SEGMENT_FILE_RE.test(item)) continue;
          const qualityLike = /(?:^|[_-])(?:\d{3,4}p|sd|hd|fhd|uhd)(?:$|[/?#])/i.test(item);
          if (!PLAYLIST_HINT_RE.test(item) && !item.toLowerCase().includes("m3u8") && !qualityLike) continue;
          const proxied = toPlayableProxyFromManifestLine(item, candidate);
          if (proxied) local.push(proxied);
        }
        return local;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        opts?.pushDiag?.(`expand variants skipped: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }
  );
  const extras = extrasByParent.flat();
  return dedupeUrls([...base, ...extras]);
}

function buildR2StatusSignature(status: MatchR2Status | null | undefined) {
  if (!status?.servers?.length) return "none";
  const servers = [...status.servers]
    .sort((a, b) => a.slotServer - b.slotServer)
    .map((item) =>
      [
        item.uiServer,
        item.slotServer,
        item.state,
        item.reason || "",
        item.playlistUrl || "",
        item.segmentProbe || "unknown",
        Number.isFinite(Number(item.lastSequenceAgeMs)) ? Number(item.lastSequenceAgeMs) : "na",
        item.resolverState || "unknown",
        item.resolveReason || "",
      ].join("|")
    )
    .join(";");
  return `${status.mode}|${servers}`;
}

function getStrictServerSubtitle(
  entry: R2StatusServerEntry | undefined,
  health: ServerHealthState,
  hasUrl: boolean,
  hasSource: boolean,
  bootstrapPending: boolean,
  bootstrapAttempted: boolean
) {
  if (entry?.state === "ready") return "مباشر";
  if (!hasSource) return "لا يوجد بث";
  if (
    entry?.state === "down" ||
    entry?.resolverState === "missing-source" ||
    entry?.resolverState === "no-candidate" ||
    String(entry?.reason || "").startsWith("seed-rejected:") ||
    String(entry?.reason || "").startsWith("seed-stalled:")
  ) {
    return "لا يوجد بث";
  }
  if (bootstrapPending) return "جاري التحضير";
  if (!entry && !bootstrapAttempted) return "جاري التحضير";
  if (entry?.state === "warming" || health === "pending") return "جاري التحضير";
  if (entry?.state === "down" || health === "down" || !hasUrl) return "لا يوجد بث";
  return "جاري التحضير";
}

function mergeR2StatusIfChanged(prev: MatchR2Status | null, next: MatchR2Status | null) {
  if (!next) return prev;
  return buildR2StatusSignature(prev) === buildR2StatusSignature(next) ? prev : next;
}

export default function WatchPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerHostRef = useRef<HTMLDivElement | null>(null);

  const rawId = useMemo(() => {
    const v = (params as Record<string, string | string[] | undefined>)?.id;
    return Array.isArray(v) ? v[0] : v;
  }, [params]);

  const idNum = useMemo(() => {
    const s = String(rawId || "").trim();
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [rawId]);

  const [match, setMatch] = useState<MatchRow | null>(null);
  const [r2Status, setR2Status] = useState<MatchR2Status | null>(null);
  const [viewerSessionId] = useState<string>(() => getOrCreateViewerSessionId());
  const [derivedServer3Url, setDerivedServer3Url] = useState<string | null>(null);
  const [server3DeriveState, setServer3DeriveState] = useState<Server3DeriveState>("idle");
  const [server3VerifiedAvailable, setServer3VerifiedAvailable] = useState<boolean | null>(null);
  const [, setDerivedServerVariants] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [hlsInstance, setHlsInstance] = useState<Hls | null>(null);
  const [strictBootstrapPendingBySlot, setStrictBootstrapPendingBySlot] = useState<Record<number, boolean>>({});
  const [strictBootstrapAttemptedBySlot, setStrictBootstrapAttemptedBySlot] = useState<Record<number, boolean>>({});

  const [selectedServer, setSelectedServer] = useState(4);
  const [runtimeServer5Url, setRuntimeServer5Url] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resolverLoading, setResolverLoading] = useState(false);
  const [resolverError, setResolverError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [resolveRevision, setResolveRevision] = useState(0);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [strictPlaybackDiag, setStrictPlaybackDiag] = useState<string | null>(null);
  const [strictRecoveryState, setStrictRecoveryState] = useState<StrictRecoveryState>("healthy");
  const [strictBreakerUntilMs, setStrictBreakerUntilMs] = useState<number | null>(null);
  const [serverHealth, setServerHealth] = useState<Record<number, ServerHealthState>>({});
  const [diagLogs, setDiagLogs] = useState<string[]>([]);
  const [isTfPlayerHost, setIsTfPlayerHost] = useState(false);
  const [repackBypassVersion, setRepackBypassVersion] = useState(0);
  const candidatesRef = useRef<string[]>([]);
  const selectedCandidateRef = useRef(0);
  const selectedServerRef = useRef(4);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryAttemptRef = useRef(0);
  const strictRetryStepRef = useRef(0);
  const strictRecoveryTimerRef = useRef<number | null>(null);
  const strictBreakerTimerRef = useRef<number | null>(null);
  const strictRecoveryStateRef = useRef<StrictRecoveryState>("healthy");
  const lastResolveKickRef = useRef(0);
  const resolveLockRef = useRef(false);
  const pendingResolveKickReasonRef = useRef<string | null>(null);
  const activeResolveIdRef = useRef(0);
  const lastProgressRef = useRef(0);
  const lastProgressAtRef = useRef(Date.now());
  const userPausedRef = useRef(false);
  const ignorePauseTrackingRef = useRef(false);
  const stallTimerRef = useRef<number | null>(null);
  const lastDiagLineRef = useRef<string>("");
  const lastDiagAtRef = useRef(0);
  const badCandidateKeysByServerRef = useRef<Record<number, Set<string>>>({
    1: new Set<string>(),
    3: new Set<string>(),
    5: new Set<string>(),
  });
  const networkFatalCountByCandidateRef = useRef<Map<string, { count: number; at: number }>>(new Map());
  const server3ProvenanceRef = useRef<Map<string, Server3CandidateProvenance>>(new Map());
  const lastFastFailoverAtByServerRef = useRef<Record<number, number>>({ 1: 0, 3: 0, 5: 0 });
  const server5RefreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const server5PrewarmResolveInFlightRef = useRef<Map<string, Promise<string[]>>>(new Map());
  const server3AutoSwitchWindowRef = useRef<{ windowStart: number; count: number }>({ windowStart: 0, count: 0 });
  const repackSeedSentRef = useRef<Map<string, number>>(new Map());
  const badRepackSeedCandidatesByServerRef = useRef<Record<number, Set<string>>>({
    1: new Set<string>(),
    2: new Set<string>(),
    3: new Set<string>(),
    4: new Set<string>(),
  });
  const lastRepackSeedCandidateKeyByServerRef = useRef<Record<number, string>>({});
  const repackBypassServersRef = useRef<Set<number>>(new Set());
  const repackFallbackReasonByServerRef = useRef<Record<number, string>>({});
  const repackCacheStatusByServerRef = useRef<Record<number, string>>({});
  const repackStallCountByServerRef = useRef<Record<number, number>>({});
  const repackRecoveryErrorCountByServerRef = useRef<Record<number, number>>({});
  const repackPlaybackStartedAtByServerRef = useRef<Record<number, number>>({});
  const strictLastReadyUrlByServerRef = useRef<Record<number, { url: string; updatedAt: number }>>({});

  const runtimeRepackFlags = useMemo(() => buildClientRepackFlags(match?.repack ?? null), [match?.repack]);
  const p2pEnabledServerSet = useMemo(() => {
    const picked = Array.from(runtimeRepackFlags.p2pServers).filter(
      (serverId) => !!getServerCapability(serverId)?.p2pEligible
    );
    return new Set<number>(picked);
  }, [runtimeRepackFlags]);

  const diagQueryEnabled = searchParams.get("diag") === "1";
  const [diagVisible, setDiagVisible] = useState(diagQueryEnabled);
  const effectiveDiagEnabled = diagVisible;
  useEffect(() => {
    setDiagVisible(diagQueryEnabled);
  }, [diagQueryEnabled]);
  useEffect(() => {
    strictRecoveryStateRef.current = strictRecoveryState;
  }, [strictRecoveryState]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = String(window.location.hostname || "").toLowerCase();
    setIsTfPlayerHost(host === "tf-player.site" || host.endsWith(".tf-player.site"));
  }, []);
  const pushDiag = useCallback((line: string) => {
    if (!effectiveDiagEnabled) return;
    const now = Date.now();
    if (R2_STRICT_MODE && line === lastDiagLineRef.current && now - lastDiagAtRef.current < 2500) return;
    lastDiagLineRef.current = line;
    lastDiagAtRef.current = now;
    setDiagLogs((prev) => [line, ...prev].slice(0, 120));
  }, [effectiveDiagEnabled]);

  const reportRepackPlaybackDiag = useCallback(
    (context: string, serverId: number, playlistUrl: string) => {
      const startedAt = repackPlaybackStartedAtByServerRef.current[serverId] || Date.now();
      const elapsedMinutes = Math.max(0.1, (Date.now() - startedAt) / 60_000);
      const stallCount = repackStallCountByServerRef.current[serverId] || 0;
      const stallRate = (stallCount / elapsedMinutes).toFixed(2);
      const fallbackReason = repackFallbackReasonByServerRef.current[serverId] || "none";
      const cacheStatus = repackCacheStatusByServerRef.current[serverId] || "unknown";
      pushDiag(
        `repack ${context} s${serverId} on=${isRepackPlaylistUrl(playlistUrl) ? 1 : 0} fallback=${fallbackReason} cache=${cacheStatus} stall_rate=${stallRate}/min`
      );
    },
    [pushDiag]
  );

  const requestRepackSeed = useCallback(
    async (params: { serverId: number; sourceUrl: string; sourceCandidate: string }) => {
      if (!R2_STRICT_MODE) return;
      if (!idNum || !match) return;
      const capability = getServerCapability(params.serverId);
      if (!capability?.repackEligible) return;
      if (!runtimeRepackFlags.enabled) return;
      if (!runtimeRepackFlags.repackServers.has(params.serverId)) return;
      const sourceCandidate = String(params.sourceCandidate || "").trim();
      const sourceUrl = String(params.sourceUrl || "").trim();
      const candidateUnderlying = toUnderlyingUrl(sourceCandidate) || sourceCandidate;
      const sourceUnderlying = toUnderlyingUrl(sourceUrl) || sourceUrl;
      const payloadCandidate = shouldUseUnderlyingForRepackSeed(sourceCandidate) ? candidateUnderlying : sourceCandidate;
      const payloadSourceUrl = shouldUseUnderlyingForRepackSeed(sourceUrl) ? sourceUnderlying : sourceUrl;
      const payloadCandidateKey = canonicalizeUrl(candidateUnderlying) || String(candidateUnderlying || "").trim().toLowerCase();
      if (!sourceCandidate || !sourceUrl) return;
      if (!isValidHttpUrl(candidateUnderlying) || !isValidHttpUrl(sourceUnderlying)) return;
      if (isRepackPlaylistUrl(candidateUnderlying) || isRepackPlaylistUrl(sourceUnderlying)) return;
      const badSeedSet = badRepackSeedCandidatesByServerRef.current[params.serverId] || new Set<string>();
      if (payloadCandidateKey && badSeedSet.has(payloadCandidateKey)) {
        pushDiag(`repack seed s${params.serverId} skip-bad-candidate`);
        return;
      }
      const dedupeKey = `${idNum}:${params.serverId}:${canonicalizeUrl(payloadSourceUrl) || payloadSourceUrl}|${
        canonicalizeUrl(payloadCandidate) || payloadCandidate
      }`;
      const now = Date.now();
      for (const [key, sentAt] of repackSeedSentRef.current.entries()) {
        if (now - sentAt > REPACK_SEED_DEDUPE_WINDOW_MS * 8) {
          repackSeedSentRef.current.delete(key);
        }
      }
      const lastSentAt = repackSeedSentRef.current.get(dedupeKey) || 0;
      if (now - lastSentAt < REPACK_SEED_DEDUPE_WINDOW_MS) return;
      repackSeedSentRef.current.set(dedupeKey, now);
      try {
        const response = await fetch("/api/repack/seed", {
          method: "POST",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            matchId: idNum,
            serverId: params.serverId,
            sourceUrl: payloadSourceUrl,
            sourceCandidate: payloadCandidate,
            matchStatus: String(match.status_key || ""),
            matchStart: String(match.match_start || ""),
            viewerSessionId,
          }),
          keepalive: true,
        });
        const body = await response.json().catch(() => null);
        const accepted = Boolean(body?.result?.accepted);
        if (accepted && payloadCandidateKey) {
          lastRepackSeedCandidateKeyByServerRef.current[params.serverId] = payloadCandidateKey;
        }
        pushDiag(`repack seed s${params.serverId} status=${response.status} accepted=${accepted ? 1 : 0}`);
      } catch (error: unknown) {
        pushDiag(`repack seed s${params.serverId} fail=${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [idNum, match, pushDiag, runtimeRepackFlags, viewerSessionId]
  );

  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  useEffect(() => {
    selectedCandidateRef.current = selectedCandidate;
  }, [selectedCandidate]);

  useEffect(() => {
    selectedServerRef.current = selectedServer;
    if (selectedServer !== 3) {
      server3AutoSwitchWindowRef.current = { windowStart: 0, count: 0 };
    }
    if (R2_STRICT_MODE) setStrictPlaybackDiag(null);
  }, [selectedServer]);

  useEffect(() => {
    setServer3VerifiedAvailable(null);
    server3AutoSwitchWindowRef.current = { windowStart: 0, count: 0 };
  }, [match?.id, match?.stream_url_3, derivedServer3Url]);

  useEffect(() => {
    repackSeedSentRef.current = new Map();
    strictLastReadyUrlByServerRef.current = {};
    badRepackSeedCandidatesByServerRef.current = {
      1: new Set<string>(),
      2: new Set<string>(),
      3: new Set<string>(),
      4: new Set<string>(),
    };
    lastRepackSeedCandidateKeyByServerRef.current = {};
    repackBypassServersRef.current = new Set();
    repackFallbackReasonByServerRef.current = {};
    repackCacheStatusByServerRef.current = {};
    repackStallCountByServerRef.current = {};
    repackRecoveryErrorCountByServerRef.current = {};
    repackPlaybackStartedAtByServerRef.current = {};
    if (strictRecoveryTimerRef.current !== null) {
      clearTimeout(strictRecoveryTimerRef.current);
      strictRecoveryTimerRef.current = null;
    }
    if (strictBreakerTimerRef.current !== null) {
      clearTimeout(strictBreakerTimerRef.current);
      strictBreakerTimerRef.current = null;
    }
    strictRetryStepRef.current = 0;
    strictRecoveryStateRef.current = "healthy";
    setStrictRecoveryState("healthy");
    setStrictBreakerUntilMs(null);
    setRepackBypassVersion((prev) => prev + 1);
    if (R2_STRICT_MODE) setR2Status(null);
  }, [idNum]);

  const mergeServer3Provenance = useCallback((incoming?: Map<string, Server3CandidateProvenance>) => {
    if (!incoming || !incoming.size) return;
    const store = server3ProvenanceRef.current;
    for (const [key, next] of incoming.entries()) {
      const picked = pickBetterServer3Provenance(store.get(key), next);
      store.set(key, picked);
    }
  }, []);

  const markCandidateAsBad = useCallback((server: number, candidate: string, reason: string) => {
    if (!isFastFailoverServer(server)) return;
    const key = candidateFailureKey(candidate);
    if (!key) return;
    const store = badCandidateKeysByServerRef.current;
    const set = store[server] || new Set<string>();
    const wasKnown = set.has(key);
    set.add(key);
    store[server] = set;
    if (!wasKnown) pushDiag(`bad-candidate-mark server${server} (${reason})`);
  }, [pushDiag]);

  const clearCandidateFailureMarks = useCallback((server: number, candidate: string) => {
    const key = candidateFailureKey(candidate);
    if (!key) return;
    networkFatalCountByCandidateRef.current.delete(key);
    if (!isFastFailoverServer(server)) return;
    const set = badCandidateKeysByServerRef.current[server];
    if (set?.delete(key)) {
      pushDiag(`bad-candidate-clear server${server}`);
    }
  }, [pushDiag]);

  const filterCandidatesByHealth = useCallback((server: number, input: string[]) => {
    const base = dedupeUrls(input);
    if (!isFastFailoverServer(server)) return base;
    const blocked = badCandidateKeysByServerRef.current[server];
    if (!blocked || !blocked.size) return base;

    const filtered = base.filter((candidate) => !blocked.has(candidateFailureKey(candidate)));
    if (!filtered.length && base.length) {
      pushDiag(`bad-candidate-skip server${server} fallback-all`);
      return base;
    }
    if (filtered.length !== base.length) {
      pushDiag(`bad-candidate-skip server${server} removed=${base.length - filtered.length}`);
    }
    return filtered;
  }, [pushDiag]);

  const prioritizeCandidatesByServer = useCallback((server: number, input: string[]) => {
    let base = dedupeUrls(input);
    if (server === 5 && base.length > 1) {
      base = base
        .map((candidate, idx) => ({ candidate, idx, score: scoreServer5Candidate(candidate) }))
        .sort((a, b) => (b.score === a.score ? a.idx - b.idx : b.score - a.score))
        .map((item) => item.candidate);
    }
    if (server === 2 && base.length > 1) {
      const onlySiiir = base.filter((candidate) => isServer2SiiirRelatedCandidate(candidate));
      if (onlySiiir.length && onlySiiir.length !== base.length) {
        pushDiag(`server2 drop-non-siiir=${base.length - onlySiiir.length}`);
        base = onlySiiir;
      } else if (!onlySiiir.length && base.length) {
        pushDiag("server2 keep-all no-siiir-hint");
      }
    }
    if (server !== 3 || base.length < 2) return base;

    const withoutExternalRelay = base.filter((candidate) => !isLivehdExternalRelayUrl(candidate));
    if (withoutExternalRelay.length && withoutExternalRelay.length !== base.length) {
      pushDiag(`server3 drop-external-relay=${base.length - withoutExternalRelay.length}`);
      base = withoutExternalRelay;
    } else if (!withoutExternalRelay.length && base.length) {
      pushDiag("server3 drop-external-relay fallback-all");
    }

    const withoutSegments = base.filter((candidate) => !SEGMENT_FILE_RE.test(toUnderlyingUrl(candidate)));
    if (withoutSegments.length && withoutSegments.length !== base.length) {
      pushDiag(`server3 drop-segments=${base.length - withoutSegments.length}`);
      base = withoutSegments;
    } else if (!withoutSegments.length && base.length) {
      pushDiag("server3 drop-segments fallback-all");
    }

    const withoutLikelyExpiredReplay = base.filter((candidate) => !isLikelyExpiredReplayManifestUrl(candidate));
    if (withoutLikelyExpiredReplay.length && withoutLikelyExpiredReplay.length !== base.length) {
      pushDiag(`server3 drop-expired-replay=${base.length - withoutLikelyExpiredReplay.length}`);
      base = withoutLikelyExpiredReplay;
    } else if (!withoutLikelyExpiredReplay.length && base.length) {
      pushDiag("server3 drop-expired-replay fallback-all");
    }

    const sortByScore = (values: string[]) =>
      values
        .map((candidate, idx) => ({ candidate, idx, score: scoreServer3Candidate(candidate) }))
        .sort((a, b) => (b.score === a.score ? a.idx - b.idx : b.score - a.score))
        .map((item) => item.candidate);

    const buckets = splitServer3CandidatesByRootServ(base, server3ProvenanceRef.current);
    const bucket0Sorted = sortByScore(buckets.bucket0);
    const bucket1Sorted = sortByScore(buckets.bucket1);
    const ordered = [...bucket0Sorted, ...bucket1Sorted];
    const collapsed = collapseServer3EquivalentCandidates(ordered);
    if (collapsed.length !== ordered.length) {
      pushDiag(`server3 collapse-equivalent=${ordered.length - collapsed.length}`);
    }
    return collapsed;
  }, [pushDiag]);

  const applyCandidatesPreservingSelection = useCallback((nextCandidates: string[]) => {
    const server = selectedServerRef.current;
    const normalizedCandidates = (() => {
      const base = dedupeUrls(nextCandidates || []);
      const repackBypassActive =
        server >= 1 && server <= 4 && repackBypassServersRef.current.has(server);
      if (!repackBypassActive) return base;
      const out: string[] = [];
      for (const candidate of base) {
        const raw = String(candidate || "").trim();
        if (!raw) continue;
        if (raw.startsWith("/api/embed-proxy?")) {
          out.push(raw);
          continue;
        }
        const underlying = String(toUnderlyingUrl(raw) || raw).trim();
        if (!isValidHttpUrl(underlying)) continue;
        const proxied = toEmbedProxyUrl(underlying, underlying);
        if (proxied) out.push(proxied);
      }
      return dedupeUrls(out);
    })();
    const prioritized = prioritizeCandidatesByServer(server, normalizedCandidates);
    const next = filterCandidatesByHealth(server, prioritized);
    const prev = candidatesRef.current;
    const prevIdx = selectedCandidateRef.current;
    const prevUrl = prev[prevIdx] || "";
    let nextIdx = prevIdx;

    if (!next.length) {
      nextIdx = 0;
    } else if (prevUrl) {
      const prevKey = canonicalizeUrl(prevUrl) || prevUrl;
      const foundIdx = next.findIndex((item) => (canonicalizeUrl(item) || item) === prevKey);
      if (foundIdx >= 0) nextIdx = foundIdx;
      else if (nextIdx >= next.length) nextIdx = 0;
    } else if (nextIdx >= next.length) {
      nextIdx = 0;
    }

    // Server 3 policy: when a serv=0 sibling exists, prefer it as default over serv=1.
    if (server === 3 && next.length > 1) {
      const activeServ = getServer3RootServFromCandidate(next[nextIdx] || "", server3ProvenanceRef.current);
      const bestServ = getServer3RootServFromCandidate(next[0] || "", server3ProvenanceRef.current);
      if (bestServ === 0 && activeServ !== 0) {
        nextIdx = 0;
        pushDiag("server3 default->serv0");
      }
    }

    candidatesRef.current = next;
    if (nextIdx !== prevIdx) {
      selectedCandidateRef.current = nextIdx;
      setSelectedCandidate(nextIdx);
    }
    setCandidates(next);
  }, [filterCandidatesByHealth, prioritizeCandidatesByServer, pushDiag]);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const clearStrictRecoveryTimers = useCallback(() => {
    if (strictRecoveryTimerRef.current !== null) {
      clearTimeout(strictRecoveryTimerRef.current);
      strictRecoveryTimerRef.current = null;
    }
    if (strictBreakerTimerRef.current !== null) {
      clearTimeout(strictBreakerTimerRef.current);
      strictBreakerTimerRef.current = null;
    }
  }, []);

  const resetRecoveryState = useCallback(() => {
    recoveryAttemptRef.current = 0;
    pendingResolveKickReasonRef.current = null;
    clearRecoveryTimer();
    clearStrictRecoveryTimers();
    strictRetryStepRef.current = 0;
    strictRecoveryStateRef.current = "healthy";
    setStrictRecoveryState("healthy");
    setStrictBreakerUntilMs(null);
  }, [clearRecoveryTimer, clearStrictRecoveryTimers]);

  const bumpResolveRevision = useCallback((reason: string) => {
    if (resolveLockRef.current) {
      pushDiag(`resolve locked (${reason})`);
      return false;
    }
    const now = Date.now();
    if (now - lastResolveKickRef.current < RESOLVE_COOLDOWN_MS) {
      pushDiag(`resolve cooldown (${reason})`);
      return false;
    }
    lastResolveKickRef.current = now;
    setResolveRevision((prev) => prev + 1);
    pushDiag(`resolve bump (${reason})`);
    return true;
  }, [pushDiag]);

  const scheduleResolveRecovery = useCallback(
    (reason: string, immediate = false) => {
      clearRecoveryTimer();
      if (R2_STRICT_MODE) {
        const video = videoRef.current;
        const suppressTransientUi =
          !!video &&
          !video.paused &&
          !video.seeking &&
          !userPausedRef.current &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          Date.now() - lastProgressAtRef.current <= 2500 &&
          /(repack|network|media|stall|unavailable|fatal)/i.test(String(reason || ""));
        if (suppressTransientUi) {
          setPlayerError((prev) => (prev ? null : prev));
          setStrictPlaybackDiag((prev) => (prev ? null : prev));
          pushDiag(`strict recovery suppressed (${reason})`);
          return;
        }
        if (strictRecoveryStateRef.current === "breaker_open") return;
        if (strictRecoveryTimerRef.current !== null) return;
        const step = strictRetryStepRef.current;
        if (step >= STRICT_R2_BACKOFF_MS.length) {
          const breakerUntil = Date.now() + STRICT_R2_BREAKER_OPEN_MS;
          clearStrictRecoveryTimers();
          strictRecoveryStateRef.current = "breaker_open";
          setStrictRecoveryState("breaker_open");
          setStrictBreakerUntilMs(breakerUntil);
          strictRetryStepRef.current = STRICT_R2_BACKOFF_MS.length;
          applyCandidatesPreservingSelection([]);
          setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
          setPlayerError("تعذر تشغيل R2 الآن. تم إيقاف المحاولات مؤقتًا، اضغط إعادة المحاولة.");
          pushDiag(`strict breaker open (${reason})`);
          strictBreakerTimerRef.current = window.setTimeout(() => {
            strictBreakerTimerRef.current = null;
            strictRetryStepRef.current = 0;
            strictRecoveryStateRef.current = "healthy";
            setStrictRecoveryState("healthy");
            setStrictBreakerUntilMs(null);
          }, STRICT_R2_BREAKER_OPEN_MS);
          return;
        }

        const delay = STRICT_R2_BACKOFF_MS[step];
        strictRetryStepRef.current = step + 1;
        strictRecoveryStateRef.current = "retrying";
        setStrictRecoveryState("retrying");
        setPlayerError(`تعذر تشغيل R2 مؤقتًا... إعادة المحاولة خلال ${Math.ceil(delay / 1000)} ثانية.`);
        pushDiag(`strict retry ${strictRetryStepRef.current}/${STRICT_R2_BACKOFF_MS.length} in ${delay}ms (${reason})`);
        strictRecoveryTimerRef.current = window.setTimeout(() => {
          strictRecoveryTimerRef.current = null;
          if (strictRecoveryStateRef.current === "breaker_open") return;
          if (bumpResolveRevision(`${reason}:strict-retry`)) return;
          if (resolveLockRef.current && !pendingResolveKickReasonRef.current) {
            pendingResolveKickReasonRef.current = `${reason}:pending`;
            pushDiag(`resolve pending (${reason})`);
          }
        }, delay);
        return;
      }
      if (resolveLockRef.current) {
        if (!pendingResolveKickReasonRef.current) {
          pendingResolveKickReasonRef.current = `${reason}:pending`;
          pushDiag(`resolve pending (${reason})`);
        }
        return;
      }
      if (immediate && bumpResolveRevision(`${reason}:immediate`)) return;

      const idx = Math.min(recoveryAttemptRef.current, AUTO_RECOVERY_SCHEDULE_MS.length - 1);
      const delay = AUTO_RECOVERY_SCHEDULE_MS[idx];
      recoveryAttemptRef.current += 1;
      pushDiag(`resolve recovery (${reason}) in ${delay}ms`);
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (bumpResolveRevision(`${reason}:timer`)) return;
        if (resolveLockRef.current && !pendingResolveKickReasonRef.current) {
          pendingResolveKickReasonRef.current = `${reason}:pending`;
          pushDiag(`resolve pending (${reason})`);
        }
      }, delay);
    },
    [applyCandidatesPreservingSelection, bumpResolveRevision, clearRecoveryTimer, clearStrictRecoveryTimers, pushDiag]
  );

  useEffect(() => {
    return () => {
      clearRecoveryTimer();
      clearStrictRecoveryTimers();
      if (stallTimerRef.current !== null) {
        clearInterval(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
  }, [clearRecoveryTimer, clearStrictRecoveryTimers]);

  const strictBreakerRemainingSec = useMemo(() => {
    if (strictRecoveryState !== "breaker_open" || !strictBreakerUntilMs) return 0;
    return Math.max(0, Math.ceil((strictBreakerUntilMs - Date.now()) / 1000));
  }, [strictBreakerUntilMs, strictRecoveryState, nowMs]);

  const handleStrictRetryNow = useCallback(() => {
    if (!R2_STRICT_MODE) return;
    clearStrictRecoveryTimers();
    strictRetryStepRef.current = 0;
    strictRecoveryStateRef.current = "healthy";
    setStrictRecoveryState("healthy");
    setStrictBreakerUntilMs(null);
    setResolverError(null);
    setPlayerError(null);
    lastResolveKickRef.current = 0;
    setResolveRevision((prev) => prev + 1);
    pushDiag("strict manual-retry");
  }, [clearStrictRecoveryTimers, pushDiag]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      setErrMsg(null);
      if (idNum === null) {
        setErrMsg("رقم المباراة غير صالح.");
        setLoading(false);
        return;
      }
      try {
        const requestUrl = `/api/match/${encodeURIComponent(String(idNum))}`;
        const res = await fetch(requestUrl);
        const json = await res.json().catch(() => null);
        if (cancel) return;
        if (!res.ok) {
          setErrMsg(json?.error || `فشل تحميل المباراة (${res.status})`);
        } else {
          const loaded = json as MatchRow;
          setMatch(loaded);
          const nextStatus = (loaded.r2Status || loaded.r2_status || null) as MatchR2Status | null;
          setR2Status((prev) => mergeR2StatusIfChanged(prev, nextStatus));

          const loadedId = Number.isFinite(Number(loaded?.id)) ? Number(loaded.id) : null;
          if (loadedId && loadedId !== idNum) {
            const nextUrl = `/watch/${loadedId}`;
            router.replace(nextUrl);
          }
        }
      } catch (e: unknown) {
        if (!cancel) setErrMsg(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [idNum, router]);

  useEffect(() => {
    let cancel = false;
    const controller = new AbortController();
    (async () => {
      if (R2_STRICT_MODE) {
        setDerivedServer3Url(null);
        setServer3DeriveState("idle");
        return;
      }
      const explicitServer3 = String(match?.stream_url_3 || "").trim();
      if (explicitServer3 && isValidHttpUrl(explicitServer3)) {
        setDerivedServer3Url(null);
        setServer3DeriveState("idle");
        return;
      }

      const home = String(match?.home_team || "").trim();
      const away = String(match?.away_team || "").trim();
      if (!home && !away) {
        setDerivedServer3Url(null);
        setServer3DeriveState("empty");
        return;
      }

      const cacheKey = buildServer3DeriveCacheKey(home, away);
      if (cacheKey) {
        const cached = getServer3DeriveCacheEntry(cacheKey);
        if (cached) {
          setDerivedServer3Url(cached.url);
          setServer3DeriveState(cached.state);
          pushDiag(`server3 derive cache hit (${cached.state})`);
          return;
        }
      }

      setServer3DeriveState("loading");

      const livehdScheduleUrl = "https://livehd77.pro/matches-today/";
      const probeUrl = toEmbedProxyUrl(livehdScheduleUrl, livehdScheduleUrl);
      if (!probeUrl) {
        setDerivedServer3Url(null);
        setServer3DeriveState("error");
        if (cacheKey) setServer3DeriveCacheEntry(cacheKey, { url: null, state: "error" });
        return;
      }

      try {
        const res = await fetchWithTimeout(
          probeUrl,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1" },
          },
          CANDIDATE_PROBE_TIMEOUT_MS,
          controller.signal
        );
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (!res.ok || (!ct.includes("text/html") && !ct.includes("application/xhtml+xml"))) {
          if (!cancel) {
            setDerivedServer3Url(null);
            setServer3DeriveState("empty");
          }
          if (cacheKey) setServer3DeriveCacheEntry(cacheKey, { url: null, state: "empty" });
          return;
        }

        const html = await res.text();
        if (cancel) return;
        const picked = pickServer3LivehdFallbackPageUrl(html, home, away);
        if (picked && isValidHttpUrl(picked)) {
          setDerivedServer3Url(picked);
          setServer3DeriveState("ready");
          if (cacheKey) setServer3DeriveCacheEntry(cacheKey, { url: picked, state: "ready" });
          pushDiag(`server3 derived livehd=${picked}`);
        } else {
          setDerivedServer3Url(null);
          setServer3DeriveState("empty");
          if (cacheKey) setServer3DeriveCacheEntry(cacheKey, { url: null, state: "empty" });
          pushDiag("server3 derived livehd=none");
        }
      } catch (e: unknown) {
        if (cancel) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setDerivedServer3Url(null);
        setServer3DeriveState("error");
        if (cacheKey) setServer3DeriveCacheEntry(cacheKey, { url: null, state: "error" });
        pushDiag(`server3 derive failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancel = true;
      controller.abort();
    };
  }, [match?.stream_url_3, match?.home_team, match?.away_team, pushDiag]);

  useEffect(() => {
    let cancel = false;
    const controller = new AbortController();
    (async () => {
      if (R2_STRICT_MODE) {
        setDerivedServerVariants([]);
        return;
      }
      const primary = String(match?.stream_url || "").trim();
      if (!primary || !isValidHttpUrl(primary)) {
        setDerivedServerVariants([]);
        return;
      }
      const proxied = toEmbedProxyUrl(primary, primary);
      if (!proxied) {
        setDerivedServerVariants([primary]);
        return;
      }
      try {
        const res = await fetchWithTimeout(
          proxied,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1" },
          },
          CANDIDATE_PROBE_TIMEOUT_MS,
          controller.signal
        );
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (!res.ok || (!ct.includes("text/html") && !ct.includes("application/xhtml+xml"))) {
          if (!cancel) setDerivedServerVariants([primary]);
          return;
        }
        const html = await res.text();
        const variants = extractServerVariantUrlsFromProxyHtml(html, primary);
        if (cancel) return;
        setDerivedServerVariants(variants.length ? variants : [primary]);
        pushDiag(`derived servers=${variants.length || 1}`);
      } catch (e: unknown) {
        if (cancel) return;
        setDerivedServerVariants([primary]);
        pushDiag(`derive servers failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancel = true;
      controller.abort();
    };
  }, [match?.stream_url, pushDiag]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const matchStartMs = useMemo(() => parseMatchStartMs(match?.match_start), [match?.match_start]);
  const matchWindow = useMemo(
    () =>
      computeMatchWindowState({
        matchStartMs,
        nowMs,
        config: MATCH_WINDOW_CONFIG,
      }),
    [matchStartMs, nowMs]
  );

  const strictR2StatusBySlot = useMemo(() => {
    const out = new Map<number, R2StatusServerEntry>();
    const list = r2Status?.servers || [];
    for (const item of list) out.set(item.slotServer, item);
    return out;
  }, [r2Status]);

  const strictSourcePresentBySlot = useMemo<Record<number, boolean>>(() => {
    const slot1 = isValidHttpUrl(String(match?.stream_url || "").trim());
    const slot2 = isValidHttpUrl(String(match?.stream_url_2 || "").trim());
    const slot3 = isValidHttpUrl(String(match?.stream_url_3 || "").trim());
    const slot4 = isValidHttpUrl(String(match?.stream_url_4 || "").trim());
    return {
      1: slot1,
      2: slot2,
      3: slot3,
      4: slot4,
    };
  }, [match?.stream_url, match?.stream_url_2, match?.stream_url_3, match?.stream_url_4]);

  const serverOptions = useMemo<ServerOption[]>(() => {
    if (R2_STRICT_MODE) {
      const out: ServerOption[] = [];
      for (const uiServer of [1, 2, 3, 4] as const) {
        const slotServer = getSlotServerIdForUiServer(uiServer as UiServerId);
        const statusEntry = strictR2StatusBySlot.get(slotServer);
        const playlistUrl = String(statusEntry?.playlistUrl || "").trim();
        const readyUrl = statusEntry?.state === "ready" && isValidHttpUrl(playlistUrl) ? playlistUrl : null;
        const label = SERVER_SOURCE_LABELS[slotServer] || `سيرفر ${slotServer}`;
        out.push({
          n: slotServer,
          label,
          url: readyUrl,
          fallbackUrl: null,
          repackActive: !!readyUrl,
          repackDecisionReason: statusEntry?.reason || "status-unavailable",
          repackReadPct: 100,
          repackBucket: 0,
          sticky: false,
        });
      }
      const orderIndex = new Map<number, number>();
      SERVER_DISPLAY_ORDER.forEach((n, idx) => orderIndex.set(n, idx));
      out.sort((a, b) => (orderIndex.get(a.n) ?? 999) - (orderIndex.get(b.n) ?? 999));
      return out;
    }

    // Strict isolation: each server only uses its own dedicated URL
    const server3Source = (() => {
      const explicitServer3 = String(match?.stream_url_3 || "").trim();
      if (explicitServer3 && isValidHttpUrl(explicitServer3)) return explicitServer3;
      if (server3VerifiedAvailable === false) return null;
      const derivedServer3 = String(derivedServer3Url || "").trim();
      if (derivedServer3 && isValidHttpUrl(derivedServer3)) return derivedServer3;
      return null;
    })();
    const server5Source = (() => {
      const refreshed = String(runtimeServer5Url || "").trim();
      if (refreshed && isValidHttpUrl(refreshed)) return refreshed;
      return match?.stream_url_5 ?? null;
    })();
    const explicit: Array<string | null> = [
      match?.stream_url ?? null,
      match?.stream_url_2 ?? null,
      server3Source,
      match?.stream_url_4 ?? null,
      server5Source,
      match?.stream_url_6 ?? null,
    ];

    const out: ServerOption[] = [];
    for (let i = 0; i < 6; i += 1) {
      const n = i + 1;
      const raw = String(explicit[i] || "").trim();
      const legacyUrl = raw && isValidHttpUrl(raw) ? raw : null;
      const capability = getServerCapability(n);
      if (LIVE_ONLY_PLAYBACK && !matchWindow.inWindow) {
        const label = SERVER_SOURCE_LABELS[n] || `سيرفر ${n}`;
        out.push({
          n,
          label,
          url: null,
          fallbackUrl: null,
          repackActive: false,
          repackDecisionReason: "match-outside-window-hard-stop",
          repackReadPct: 0,
          repackBucket: -1,
          sticky: false,
        });
        continue;
      }
      const label = SERVER_SOURCE_LABELS[n] || `سيرفر ${n}`;
      const repackDecisionReason =
        legacyUrl && capability?.repackEligible ? "legacy-direct" : capability?.repackEligible ? "missing-source" : "not-eligible";
      const stickyConfig = n === 2 || n === 4;
      const sticky = stickyConfig && isSafeToCacheUrl(legacyUrl);
      out.push({
        n,
        label,
        url: legacyUrl,
        fallbackUrl: null,
        repackActive: false,
        repackDecisionReason,
        repackReadPct: 0,
        repackBucket: -1,
        sticky,
      });
    }
    const orderIndex = new Map<number, number>();
    SERVER_DISPLAY_ORDER.forEach((n, idx) => orderIndex.set(n, idx));
    out.sort((a, b) => (orderIndex.get(a.n) ?? 999) - (orderIndex.get(b.n) ?? 999));
    return out;
  }, [match, derivedServer3Url, runtimeServer5Url, server3VerifiedAvailable, matchWindow.inWindow, strictR2StatusBySlot]);

  useEffect(() => {
    if (!R2_STRICT_MODE) return;
    const now = Date.now();
    const next = { ...strictLastReadyUrlByServerRef.current };
    for (const option of serverOptions) {
      if (option.url && isValidHttpUrl(option.url)) {
        next[option.n] = {
          url: option.url,
          updatedAt: now,
        };
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if (!value?.url || now - value.updatedAt > STRICT_R2_READY_URL_GRACE_MS * 2) {
        delete next[Number(key)];
      }
    }
    strictLastReadyUrlByServerRef.current = next;
  }, [serverOptions]);

  const validServers = useMemo(() => serverOptions.filter((s) => s.url && isValidHttpUrl(s.url)), [serverOptions]);
  useEffect(() => {
    if (R2_STRICT_MODE) return;
    if (!validServers.some((s) => s.n === selectedServer) && validServers.length) setSelectedServer(validServers[0].n);
  }, [validServers, selectedServer]);
  useEffect(() => {
    if (!R2_STRICT_MODE) return;
    const readyServers = serverOptions.filter((s) => {
      if (!s.url || !isValidHttpUrl(s.url)) return false;
      const entry = strictR2StatusBySlot.get(s.n);
      return entry?.state === "ready";
    });
    if (!readyServers.length) return;
    if (readyServers.some((s) => s.n === selectedServer)) return;
    setSelectedServer(readyServers[0].n);
  }, [serverOptions, selectedServer, strictR2StatusBySlot]);

  useEffect(() => {
    setServerHealth(() => {
      if (R2_STRICT_MODE) {
        const next: Record<number, ServerHealthState> = {};
        for (const s of serverOptions) {
          const statusEntry = strictR2StatusBySlot.get(s.n);
          if (statusEntry?.state === "ready") next[s.n] = "ok";
          else if (statusEntry?.state === "warming") next[s.n] = "pending";
          else next[s.n] = "down";
        }
        return next;
      }
      const next: Record<number, ServerHealthState> = {};
      for (const s of serverOptions) {
        if (s.n === 3) {
          if (server3VerifiedAvailable === false) {
            next[s.n] = "down";
            continue;
          }
          if (s.url && isValidHttpUrl(s.url)) {
            next[s.n] = "ok";
            continue;
          }
          if (server3DeriveState === "loading") {
            next[s.n] = "pending";
            continue;
          }
          next[s.n] = "down";
          continue;
        }
        if (s.url && isValidHttpUrl(s.url)) {
          next[s.n] = "ok";
          continue;
        }
        next[s.n] = "down";
      }
      return next;
    });
  }, [serverOptions, server3DeriveState, server3VerifiedAvailable, strictR2StatusBySlot]);

  const visibleServerOptions = useMemo(() => serverOptions, [serverOptions]);

  const handleVideoDoubleClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => { });
    }
    const host = playerHostRef.current || video;
    if (!document.fullscreenElement) {
      host.requestFullscreen?.().catch(() => { });
    }
  }, []);

  const selectedOption = serverOptions.find((s) => s.n === selectedServer);
  const selectedServerLabel = selectedOption?.label || SERVER_SOURCE_LABELS[selectedServer] || `سيرفر ${selectedServer}`;
  const selectedStrictStatus = R2_STRICT_MODE ? strictR2StatusBySlot.get(selectedServer) : undefined;
  const selectedReadyUrl = selectedOption?.url ?? "";
  const cachedStrictReady = strictLastReadyUrlByServerRef.current[selectedServer];
  const canReuseStrictCachedUrl =
    R2_STRICT_MODE &&
    !selectedReadyUrl &&
    !!cachedStrictReady?.url &&
    Date.now() - cachedStrictReady.updatedAt <= STRICT_R2_READY_URL_GRACE_MS &&
    (selectedStrictStatus?.state === "warming" || selectedStrictStatus?.state === "ready");
  const selectedUrl = canReuseStrictCachedUrl ? String(cachedStrictReady?.url || "") : selectedReadyUrl;
  const selectedFallbackUrl = selectedOption?.fallbackUrl ?? "";
  const server5OptionUrl = serverOptions.find((s) => s.n === 5)?.url ?? "";
  const server5DbUrl = String(match?.stream_url_5 || "").trim();
  const streamOpenMs = matchWindow.openAtMs;
  const shouldBlockStream = LIVE_ONLY_PLAYBACK ? !matchWindow.inWindow : false;

  useEffect(() => {
    setStrictBootstrapPendingBySlot({});
    setStrictBootstrapAttemptedBySlot({});
  }, [idNum]);

  const markStrictBootstrapPending = useCallback((slotServers: number[], pending: boolean) => {
    setStrictBootstrapPendingBySlot((prev) => {
      const next = { ...prev };
      for (const slotServer of slotServers) {
        if (pending) next[slotServer] = true;
        else delete next[slotServer];
      }
      return next;
    });
  }, []);

  const markStrictBootstrapAttempted = useCallback((slotServers: number[]) => {
    setStrictBootstrapAttemptedBySlot((prev) => {
      const next = { ...prev };
      for (const slotServer of slotServers) {
        next[slotServer] = true;
      }
      return next;
    });
  }, []);

  const bootstrapStrictUiServer = useCallback(
    async (uiServer: UiServerId, signal: AbortSignal) => {
      if (!idNum) return;
      const slotServer = getSlotServerIdForUiServer(uiServer);
      const statusEntry = strictR2StatusBySlot.get(slotServer);
      const playlistUrl = String(statusEntry?.playlistUrl || "").trim();
      const terminalReason = String(statusEntry?.reason || "");
      const statusUpdatedAtMs = Number.parseInt(String(new Date(statusEntry?.updatedAt || "").getTime()), 10);
      const hasRecentStatus = Number.isFinite(statusUpdatedAtMs) && Date.now() - statusUpdatedAtMs < STRICT_BOOTSTRAP_RECENT_WINDOW_MS;
      if (statusEntry?.state === "ready" && isValidHttpUrl(playlistUrl)) {
        markStrictBootstrapPending([slotServer], false);
        markStrictBootstrapAttempted([slotServer]);
        return;
      }
      if (statusEntry?.state === "warming" && hasRecentStatus) {
        markStrictBootstrapPending([slotServer], false);
        markStrictBootstrapAttempted([slotServer]);
        return;
      }
      if (
        statusEntry?.state === "down" &&
        (terminalReason === "missing-source" ||
          terminalReason === "source-not-allowed" ||
          terminalReason === "blocked-outside-window" ||
          terminalReason.startsWith("seed-rejected:") ||
          terminalReason.startsWith("seed-stalled:") ||
          statusEntry?.resolverState === "missing-source" ||
          statusEntry?.resolverState === "no-candidate" ||
          statusEntry?.resolverState === "probe-failed")
      ) {
        markStrictBootstrapPending([slotServer], false);
        markStrictBootstrapAttempted([slotServer]);
        return;
      }
      if (!strictSourcePresentBySlot[slotServer]) {
        markStrictBootstrapPending([slotServer], false);
        markStrictBootstrapAttempted([slotServer]);
        return;
      }
      markStrictBootstrapPending([slotServer], true);
      try {
        const response = await fetch("/api/repack/bootstrap", {
          method: "POST",
          cache: "no-store",
          signal,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            matchId: idNum,
            uiServers: [uiServer],
          }),
        });
        const payload = await response.json().catch(() => null);
        if (signal.aborted) return;
        const nextStatus = payload?.r2Status as MatchR2Status | null | undefined;
        if (nextStatus?.servers?.length) {
          setR2Status((prev) => mergeR2StatusIfChanged(prev, nextStatus));
        }
      } catch {
        // Keep current status; polling endpoint will retry.
      } finally {
        if (!signal.aborted) {
          markStrictBootstrapPending([slotServer], false);
          markStrictBootstrapAttempted([slotServer]);
        }
      }
    },
    [idNum, markStrictBootstrapAttempted, markStrictBootstrapPending, strictR2StatusBySlot, strictSourcePresentBySlot]
  );

  useEffect(() => {
    if (!R2_STRICT_MODE) return;
    if (!idNum || !match?.id) return;
    if (shouldBlockStream) return;
    const controller = new AbortController();
    const orderedUiServers = [1, 2, 3, 4] as UiServerId[];
    for (const uiServer of orderedUiServers) {
      const slotServer = getSlotServerIdForUiServer(uiServer);
      if (strictBootstrapAttemptedBySlot[slotServer]) continue;
      void bootstrapStrictUiServer(uiServer, controller.signal);
    }
    return () => {
      controller.abort();
    };
  }, [bootstrapStrictUiServer, idNum, match?.id, shouldBlockStream, strictBootstrapAttemptedBySlot]);

  useEffect(() => {
    if (!R2_STRICT_MODE) return;
    if (!idNum || !match?.id) return;
    let cancel = false;
    const refresh = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const response = await fetch(`/api/repack/status?matchId=${encodeURIComponent(String(idNum))}`, {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (cancel) return;
        const nextStatus = payload?.r2Status as MatchR2Status | null | undefined;
        if (nextStatus?.servers?.length) {
          setR2Status((prev) => mergeR2StatusIfChanged(prev, nextStatus));
        }
      } catch {
        // no-op
      }
    };
    void refresh();
    const hasPendingBootstrap = Object.keys(strictBootstrapPendingBySlot).length > 0;
    const hasWarmingServer = !!r2Status?.servers?.some((entry) => entry.state === "warming");
    const timerId = window.setInterval(() => {
      void refresh();
    }, hasPendingBootstrap || hasWarmingServer ? 4000 : 15000);
    return () => {
      cancel = true;
      window.clearInterval(timerId);
    };
  }, [idNum, match?.id, strictBootstrapPendingBySlot, r2Status]);

  useEffect(() => {
    if (!selectedOption) return;
    if (!selectedOption.url || selectedOption.n > 4) return;
    pushDiag(
      `repack decision s${selectedOption.n} on=${selectedOption.repackActive ? 1 : 0} reason=${
        selectedOption.repackDecisionReason || "n/a"
      } pct=${selectedOption.repackReadPct ?? 0} bucket=${selectedOption.repackBucket ?? -1}`
    );
  }, [pushDiag, selectedOption]);

  useEffect(() => {
    if (!idNum) {
      setRuntimeServer5Url(null);
      return;
    }
    const cached = getServer5RuntimeRefreshCached(idNum, server5DbUrl);
    if (cached?.url && isValidHttpUrl(cached.url)) setRuntimeServer5Url(cached.url);
    else setRuntimeServer5Url(null);
  }, [idNum, server5DbUrl]);

  const warmServer5PrewarmCandidates = useCallback(
    async (sourceUrl: string, reason: "bg" | "click" | "resolve") => {
      const source = String(sourceUrl || "").trim();
      if (!source || !isValidHttpUrl(source) || shouldBlockStream) return [] as string[];
      const cached = getServer5PrewarmCandidates(source);
      if (cached.length) return cached;
      const key = canonicalizeUrl(source) || source.toLowerCase();
      if (!key) return [] as string[];

      const inFlight = server5PrewarmResolveInFlightRef.current.get(key);
      if (inFlight) return inFlight;

      let localPromise: Promise<string[]> | null = null;
      localPromise = (async () => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), SERVER5_PREWARM_WARM_TIMEOUT_MS);
        try {
          const resolved = await resolveCandidatesForServer(source, controller.signal, {
            playerv2Diag: pushDiag,
            parallelChildConcurrency: 2,
            allowSamePathServVariants: false,
            server5Mode: "fast",
            server5LandingLimit: Math.min(3, SERVER5_FAST_LANDING_LIMIT),
            server5ChannelKeyLimit: Math.min(2, SERVER5_FAST_CHANNEL_KEY_LIMIT),
            server5AllowSitemap: false,
            server5SearchTerms: [match?.home_team ?? "", match?.away_team ?? ""],
            maxPlayerPages: 2,
            maxDeepCandidates: 2,
            maxPlayerv2Pool: 0,
            fetchTimeoutMs: Math.min(1800, FAST_PHASE_PROBE_TIMEOUT_MS),
            fetchRetries: 0,
            fetchRetryDelayMs: 0,
          });
          const scoped = prioritizeServer5Candidates(
            resolved.candidates.filter((candidate) => isServer5AuthReadyCandidate(candidate))
          );
          const maxChecks = Math.min(SERVER5_PREWARM_WARM_MAX_CHECKS, scoped.length);
          if (maxChecks <= 0) {
            pushDiag(`server5 prewarm ${reason} raw=0`);
            return [] as string[];
          }
          const verified = prioritizeServer5Candidates(
            await filterPlayableCandidates(scoped, {
              signal: controller.signal,
              timeoutMs: SERVER5_PREWARM_WARM_PROBE_TIMEOUT_MS,
              maxChildChecks: 1,
              maxChecks,
              concurrency: Math.min(2, PROBE_CONCURRENCY),
              pushDiag,
            })
          );
          if (verified.length) {
            setServer5PrewarmCandidates(source, verified);
            pushDiag(`server5 prewarm ${reason} verified=${verified.length}/${maxChecks}`);
          } else {
            pushDiag(`server5 prewarm ${reason} verified=0/${maxChecks}`);
          }
          return verified;
        } catch (e: unknown) {
          if (!(e instanceof Error && e.name === "AbortError")) {
            pushDiag(`server5 prewarm ${reason} fail: ${e instanceof Error ? e.message : String(e)}`);
          }
          return [] as string[];
        } finally {
          window.clearTimeout(timeoutId);
          if (server5PrewarmResolveInFlightRef.current.get(key) === localPromise) {
            server5PrewarmResolveInFlightRef.current.delete(key);
          }
        }
      })();
      server5PrewarmResolveInFlightRef.current.set(key, localPromise);
      return localPromise;
    },
    [match?.away_team, match?.home_team, pushDiag, shouldBlockStream]
  );

  const requestServer5Refresh = useCallback(
    async (reason: "bg" | "click") => {
      if (R2_STRICT_MODE) return null as string | null;
      if (!idNum) return null as string | null;
      const sourceUrl = String(server5DbUrl || "").trim();
      if (!sourceUrl || !isValidHttpUrl(sourceUrl) || shouldBlockStream) return null;

      const cached = getServer5RuntimeRefreshCached(idNum, sourceUrl);
      if (cached) {
        if (cached.url && isValidHttpUrl(cached.url)) {
          setRuntimeServer5Url(cached.url);
          void warmServer5PrewarmCandidates(cached.url, reason);
        }
        pushDiag(`server5 refresh ${reason} cache=${cached.status}`);
        return cached.url || null;
      }

      if (server5RefreshInFlightRef.current) return server5RefreshInFlightRef.current;

      const query = new URLSearchParams();
      query.set("s5", "refresh");
      const matchKey = String(match?.match_key || "").trim();
      if (matchKey) query.set("k", matchKey);
      const requestUrl = `/api/match/${idNum}?${query.toString()}`;

      let localPromise: Promise<string | null> | null = null;
      localPromise = (async () => {
        try {
          const response = await fetch(requestUrl, { cache: "no-store" });
          const refreshStatus = String(response.headers.get("x-server5-refresh") || "skip").trim().toLowerCase();
          const refreshMs = String(response.headers.get("x-server5-refresh-ms") || "0").trim();
          let refreshedUrl: string | null = null;
          if (response.ok) {
            const payload = (await response.json()) as MatchRow;
            const maybe = String(payload?.stream_url_5 || "").trim();
            if (maybe && isValidHttpUrl(maybe)) refreshedUrl = maybe;
          }
          setServer5RuntimeRefreshCached(idNum, sourceUrl, {
            status: (refreshStatus === "hit" || refreshStatus === "miss" ? refreshStatus : "skip"),
            url: refreshedUrl,
          });
          if (refreshedUrl) {
            setRuntimeServer5Url(refreshedUrl);
            void warmServer5PrewarmCandidates(refreshedUrl, reason);
          }
          pushDiag(`server5 refresh ${reason} ${refreshStatus} ${refreshMs}ms`);
          return refreshedUrl;
        } catch (e: unknown) {
          setServer5RuntimeRefreshCached(idNum, sourceUrl, { status: "miss", url: null });
          pushDiag(`server5 refresh ${reason} fail: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        } finally {
          if (server5RefreshInFlightRef.current === localPromise) {
            server5RefreshInFlightRef.current = null;
          }
        }
      })();
      server5RefreshInFlightRef.current = localPromise;
      return localPromise;
    },
    [idNum, match?.match_key, pushDiag, server5DbUrl, shouldBlockStream, warmServer5PrewarmCandidates]
  );

  useEffect(() => {
    if (R2_STRICT_MODE) return;
    if (selectedServer === 5) return;
    if (!server5OptionUrl || !isValidHttpUrl(server5OptionUrl)) return;
    if (shouldBlockStream) return;
    void requestServer5Refresh("bg");
  }, [requestServer5Refresh, selectedServer, server5OptionUrl, shouldBlockStream]);

  useEffect(() => {
    if (R2_STRICT_MODE) return;
    if (selectedServer !== 5) return;
    if (!server5OptionUrl || !isValidHttpUrl(server5OptionUrl)) return;
    if (shouldBlockStream) return;
    void requestServer5Refresh("click");
  }, [requestServer5Refresh, selectedServer, server5OptionUrl, shouldBlockStream]);

  useEffect(() => {
    selectedCandidateRef.current = 0;
    setSelectedCandidate(0);
    setPlayerError(null);
    setResolverError(null);
    resetRecoveryState();
    if (selectedServer !== 3) server3ProvenanceRef.current = new Map();
  }, [selectedServer, resetRecoveryState]);
  useEffect(() => {
    if (selectedCandidate >= candidates.length) {
      selectedCandidateRef.current = 0;
      setSelectedCandidate(0);
    }
  }, [candidates.length, selectedCandidate]);

  useEffect(() => {
    if (R2_STRICT_MODE) return;
    if (!idNum || shouldBlockStream) return;
    if (selectedServer < 1 || selectedServer > 4) return;
    if (!isRepackPlaylistUrl(selectedUrl)) return;
    if (repackBypassServersRef.current.has(selectedServer)) return;
    const fallbackProbe = String(selectedFallbackUrl || "").trim();
    const needsTokenRefresh =
      isPlayerv2LikeUrl(fallbackProbe) || /[?&](?:token|sid|nonce|ts)=/i.test(fallbackProbe);
    if (!needsTokenRefresh) return;

    const timerId = window.setInterval(() => {
      const now = Date.now();
      if (resolveLockRef.current) {
        pendingResolveKickReasonRef.current = "repack-token-refresh";
        return;
      }
      if (now - lastResolveKickRef.current < RESOLVE_COOLDOWN_MS) return;
      lastResolveKickRef.current = now;
      setResolveRevision((prev) => prev + 1);
      pushDiag("resolve bump (repack-token-refresh)");
    }, REPACK_TOKEN_REFRESH_KICK_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [idNum, selectedServer, selectedUrl, selectedFallbackUrl, shouldBlockStream, pushDiag]);

  useEffect(() => {
    let cancel = false;
    const controller = new AbortController();
    const resolveId = activeResolveIdRef.current + 1;
    activeResolveIdRef.current = resolveId;
    resolveLockRef.current = true;
    (async () => {
      if (!selectedUrl || shouldBlockStream) {
        applyCandidatesPreservingSelection([]);
        setResolverError(null);
        setResolverLoading(false);
        resolveLockRef.current = false;
        resetRecoveryState();
        return;
      }
      if (R2_STRICT_MODE) {
        if (strictRecoveryStateRef.current === "breaker_open") {
          applyCandidatesPreservingSelection([]);
          setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
          setResolverLoading(false);
          resolveLockRef.current = false;
          return;
        }
        const strictCandidates = isValidHttpUrl(selectedUrl) ? [selectedUrl] : [];
        applyCandidatesPreservingSelection(strictCandidates);
        setResolverError(strictCandidates.length ? null : NO_STREAM_SELECTED_SERVER_MESSAGE);
        setResolverLoading(false);
        if (strictCandidates.length) setPlayerError(null);
        resolveLockRef.current = false;
        return;
      }
      const repackPrimaryOnlyMode =
        isRepackPlaylistUrl(selectedUrl) && !repackBypassServersRef.current.has(selectedServer);
      const resolveSourceUrl =
        repackPrimaryOnlyMode &&
        selectedFallbackUrl &&
        isValidHttpUrl(selectedFallbackUrl)
          ? selectedFallbackUrl
          : selectedUrl;
      const server5ResolveDeadlineAt = selectedServer === 5 ? Date.now() + SERVER5_RESOLVE_TOTAL_BUDGET_MS : 0;
      const getServer5ResolveBudgetRemainingMs = () =>
        selectedServer === 5 ? Math.max(0, server5ResolveDeadlineAt - Date.now()) : Number.POSITIVE_INFINITY;
      const seedCandidates = (() => {
        const seedUrls: string[] = [];
        if (selectedServer === 5) {
          const refreshed = String(runtimeServer5Url || "").trim();
          const original = String(match?.stream_url_5 || "").trim();
          if (refreshed && isValidHttpUrl(refreshed)) seedUrls.push(refreshed);
          if (original && isValidHttpUrl(original) && canonicalizeUrl(original) !== canonicalizeUrl(refreshed)) {
            seedUrls.push(original);
          }
        } else {
          seedUrls.push(resolveSourceUrl);
          if (
            !repackPrimaryOnlyMode &&
            selectedFallbackUrl &&
            isValidHttpUrl(selectedFallbackUrl) &&
            canonicalizeUrl(selectedFallbackUrl) !== canonicalizeUrl(selectedUrl)
          ) {
            seedUrls.push(selectedFallbackUrl);
          }
        }
        const out: string[] = [];
        for (const seedUrl of dedupeUrls(seedUrls)) {
          const normalizedSeed = canonicalizeUrl(seedUrl) || String(seedUrl || "").trim().toLowerCase();
          const normalizedFallback =
            canonicalizeUrl(selectedFallbackUrl) || String(selectedFallbackUrl || "").trim().toLowerCase();
          const isSelectedFallbackSeed = !!normalizedFallback && normalizedSeed === normalizedFallback;
          // Keep the selected fallback candidate even if it is not classified as "strong".
          if (!isSelectedFallbackSeed && !isStrongPlayableStreamUrl(seedUrl) && !isLikelyLivePhpEndpointUrl(seedUrl)) continue;
          if (isRepackPlaylistUrl(seedUrl)) {
            out.push(seedUrl);
            continue;
          }
          const proxied = toEmbedProxyUrl(seedUrl, seedUrl);
          if (proxied) out.push(proxied);
        }
        return out;
      })();
      const isServer1Primary = selectedServer === 1;
      const isServer2Playerv2 = selectedServer === 2 && isPlayerv2LikeUrl(resolveSourceUrl);
      const isServer3Livehd = selectedServer === 3 && isLivehd77LikeUrl(resolveSourceUrl);
      const isServer4Livekora = selectedServer === 4;
      const disableResolveCache = selectedServer === 3 || selectedServer === 4 || selectedServer === 5 || repackPrimaryOnlyMode;
      const cachedCandidates = disableResolveCache ? [] : getCachedResolveCandidates(resolveSourceUrl);
      const stickyCandidates = isServer2Playerv2 ? getPlayerv2StickyCandidates(resolveSourceUrl) : [];
      let prewarmedServer5Candidates = selectedServer === 5 ? getServer5PrewarmCandidates(selectedUrl) : [];
      if (selectedServer === 5 && !prewarmedServer5Candidates.length) {
        const warmPromise = warmServer5PrewarmCandidates(selectedUrl, "resolve");
        prewarmedServer5Candidates = await new Promise<string[]>((resolve) => {
          let settled = false;
          const timeoutId = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve([]);
          }, SERVER5_PREWARM_SYNC_WAIT_MS);
          warmPromise
            .then((value) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeoutId);
              resolve(value);
            })
            .catch(() => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeoutId);
              resolve([]);
            });
        });
      }
      const initialCandidates = repackPrimaryOnlyMode
        ? [selectedUrl]
        : dedupeUrls(
          [...prewarmedServer5Candidates, ...stickyCandidates, ...cachedCandidates, ...seedCandidates].filter((candidate) =>
            selectedServer === 5 ? isServer5AuthReadyCandidate(candidate) : true
          )
        );
      const resolveFetchTimeoutFast = isServer3Livehd
        ? LIVEHD77_FETCH_TIMEOUT_FAST_MS
        : isServer4Livekora
          ? SERVER4_FETCH_TIMEOUT_FAST_MS
          : isServer1Primary
            ? SERVER1_FETCH_TIMEOUT_FAST_MS
            : FAST_PHASE_PROBE_TIMEOUT_MS;
      const resolveFetchTimeoutFinal = isServer3Livehd
        ? LIVEHD77_FETCH_TIMEOUT_FINAL_MS
        : isServer4Livekora
          ? SERVER4_FETCH_TIMEOUT_FINAL_MS
          : isServer1Primary
            ? SERVER1_FETCH_TIMEOUT_FINAL_MS
            : selectedServer === 5
              ? SERVER5_FETCH_TIMEOUT_FINAL_MS
              : CANDIDATE_PROBE_TIMEOUT_MS;
      const probeTimeoutMs = isServer3Livehd
        ? LIVEHD77_PROBE_TIMEOUT_MS
        : isServer4Livekora
          ? SERVER4_PROBE_TIMEOUT_MS
          : isServer1Primary
            ? SERVER1_PROBE_TIMEOUT_MS
            : selectedServer === 5
              ? SERVER5_PROBE_TIMEOUT_MS
              : CANDIDATE_PROBE_TIMEOUT_MS;
      const resolveFetchRetries = isServer3Livehd
        ? LIVEHD77_FETCH_RETRIES
        : isServer4Livekora
          ? SERVER4_FETCH_RETRIES
          : isServer1Primary
            ? SERVER1_FETCH_RETRIES
            : 0;
      const resolveFetchRetryDelayMs = isServer3Livehd
        ? LIVEHD77_FETCH_RETRY_DELAY_MS
        : isServer4Livekora
          ? SERVER4_FETCH_RETRY_DELAY_MS
          : isServer1Primary
            ? SERVER1_FETCH_RETRY_DELAY_MS
            : 0;
      let hadPlayable = initialCandidates.length > 0;
      if (selectedServer === 3) server3ProvenanceRef.current = new Map();
      const mergeCandidates = (
        incoming: string[],
        provenance?: Map<string, Server3CandidateProvenance>
      ) => {
        if (!incoming.length) return;
        if (selectedServer === 3) mergeServer3Provenance(provenance);
        if (selectedServer === 5 || selectedServer === 3 || repackPrimaryOnlyMode) {
          // Server 3/5 are verified-only: do not expose raw/unverified batches to the UI.
          return;
        }
        hadPlayable = true;
        const merged = dedupeUrls([...candidatesRef.current, ...incoming]);
        applyCandidatesPreservingSelection(merged);
        setResolverError(null);
        if (isServer2Playerv2) setPlayerv2StickyCandidates(resolveSourceUrl, merged);
        if (!disableResolveCache) setCachedResolveCandidates(resolveSourceUrl, merged);
      };

      setResolverError(null);
      applyCandidatesPreservingSelection(initialCandidates);
      setResolverLoading(!initialCandidates.length);
      if (stickyCandidates.length) pushDiag(`resolve sticky hit +${stickyCandidates.length}`);
      if (cachedCandidates.length) pushDiag(`resolve cache hit +${cachedCandidates.length}`);
      if (prewarmedServer5Candidates.length) pushDiag(`server5 prewarm hit +${prewarmedServer5Candidates.length}`);
      if (seedCandidates.length) pushDiag(`resolve seed +${seedCandidates.length}`);
      try {
        const fastResolved = await resolveCandidatesForServer(resolveSourceUrl, controller.signal, {
          playerv2Diag: pushDiag,
          parallelChildConcurrency: RESOLVE_CHILD_CONCURRENCY,
          allowSamePathServVariants: selectedServer === 3 || selectedServer === 4,
          livehdServPreference: isServer3Livehd ? "prefer0" : "all",
          server5Mode: selectedServer === 5 ? "fast" : undefined,
          server5LandingLimit: selectedServer === 5 ? SERVER5_FAST_LANDING_LIMIT : undefined,
          server5ChannelKeyLimit: selectedServer === 5 ? SERVER5_FAST_CHANNEL_KEY_LIMIT : undefined,
          server5AllowSitemap: selectedServer === 5 ? false : undefined,
          server5SearchTerms: selectedServer === 5 ? [match?.home_team ?? "", match?.away_team ?? ""] : undefined,
          maxPlayerPages: isServer2Playerv2 ? 1 : FAST_PHASE_MAX_PLAYER_PAGES,
          maxDeepCandidates: isServer2Playerv2 ? 2 : FAST_PHASE_MAX_DEEP_CANDIDATES,
          maxPlayerv2Pool: isServer2Playerv2 ? 1 : FAST_PHASE_MAX_PLAYERV2_POOL,
          fetchTimeoutMs: resolveFetchTimeoutFast,
          fetchRetries: resolveFetchRetries,
          fetchRetryDelayMs: resolveFetchRetryDelayMs,
          onBatchCandidates: (batch, phase, batchProvenance) => {
            if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
            mergeCandidates(batch, batchProvenance);
            pushDiag(`resolve batch ${phase} +${batch.length} (fast)`);
          },
        });
        if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
        if (selectedServer === 3) mergeServer3Provenance(fastResolved.provenanceByKey);
        const fastList = fastResolved.candidates;
        const fastMerged = dedupeUrls([...initialCandidates, ...fastList]);
        if (selectedServer === 5) {
          const fastScopedRaw = prioritizeServer5Candidates(
            fastMerged.filter((candidate) => isServer5AuthReadyCandidate(candidate))
          );
          const refreshedSelected =
            !!runtimeServer5Url &&
            isValidHttpUrl(runtimeServer5Url) &&
            (canonicalizeUrl(selectedUrl) || selectedUrl) === (canonicalizeUrl(runtimeServer5Url) || runtimeServer5Url);
          const fastChecksLimit = refreshedSelected ? 2 : SERVER5_FAST_STAGE0_MAX_CHECKS;
          const fastChecks = Math.min(fastScopedRaw.length, fastChecksLimit);
          let fastVerifiedNow: string[] = [];
          if (fastChecks > 0) {
            fastVerifiedNow = prioritizeServer5Candidates(
              await filterPlayableCandidates(fastScopedRaw, {
                signal: controller.signal,
                timeoutMs: Math.min(probeTimeoutMs, refreshedSelected ? 1800 : SERVER5_FAST_STAGE0_TIMEOUT_MS),
                maxChildChecks: refreshedSelected ? 1 : 1,
                maxChecks: fastChecks,
                concurrency: Math.min(3, PROBE_CONCURRENCY),
                pushDiag,
              })
            );
            pushDiag(`server5 fast verified=${fastVerifiedNow.length}/${fastChecks}`);
          } else {
            pushDiag("server5 fast verified=0/0");
          }
          const fastVerifiedWithAuth = fastVerifiedNow.filter((candidate) => !!extractServer5AuthContextFromProxyCandidate(candidate));
          const fastReadyNow =
            fastVerifiedWithAuth.length
              ? fastVerifiedWithAuth
              : fastVerifiedNow.length >= 2
                ? fastVerifiedNow.slice(0, 2)
                : [];
          if (fastReadyNow.length) {
            hadPlayable = true;
            applyCandidatesPreservingSelection(fastReadyNow);
            setServer5PrewarmCandidates(selectedUrl, fastReadyNow);
            setPlayerError(null);
            setResolverError(null);
            resetRecoveryState();
            setResolverLoading(false);
          } else {
            if (fastVerifiedNow.length) pushDiag("server5 fast defer-untrusted");
            setResolverLoading(true);
          }
        } else if (selectedServer === 3) {
          if (fastMerged.length) {
            pushDiag(`server3 fast awaiting-verify raw=${fastMerged.length}`);
          }
          // Server 3 is verify-first. Do not start playback from fast (unverified) sources.
          setResolverLoading(true);
        } else if (fastMerged.length && !repackPrimaryOnlyMode) {
          hadPlayable = true;
          applyCandidatesPreservingSelection(fastMerged);
          if (isServer2Playerv2) setPlayerv2StickyCandidates(resolveSourceUrl, fastMerged);
          if (!disableResolveCache) setCachedResolveCandidates(resolveSourceUrl, fastMerged);
          setPlayerError(null);
          setResolverError(null);
          resetRecoveryState();
          setResolverLoading(false);
        } else if (repackPrimaryOnlyMode) {
          // Keep playback pinned to R2-only source list while resolver continues in background for seeding.
          setResolverLoading(false);
        } else {
          setResolverLoading(true);
        }

        if (isServer2Playerv2 && !repackPrimaryOnlyMode) {
          const stickyFallback = getPlayerv2StickyCandidates(resolveSourceUrl);
          const lightweight = dedupeUrls([...candidatesRef.current, ...fastMerged, ...stickyFallback]);
          applyCandidatesPreservingSelection(lightweight);
          if (lightweight.length) {
            hadPlayable = true;
            setPlayerv2StickyCandidates(resolveSourceUrl, lightweight);
            if (!disableResolveCache) setCachedResolveCandidates(resolveSourceUrl, lightweight);
            setPlayerError(null);
            resetRecoveryState();
            setResolverError(null);
          } else {
            setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
            scheduleResolveRecovery("resolver-empty");
          }
          setResolverLoading(false);
          return;
        }

        if (selectedServer === 5) {
          const remainingBeforeFinal = getServer5ResolveBudgetRemainingMs();
          if (remainingBeforeFinal <= 750 && candidatesRef.current.length) {
            pushDiag(`server5 budget skip-final remaining=${remainingBeforeFinal}ms`);
            setResolverLoading(false);
            return;
          }
        }

        const server5FinalFetchTimeoutMs =
          selectedServer === 5
            ? Math.min(resolveFetchTimeoutFinal, Math.max(1200, getServer5ResolveBudgetRemainingMs() - 250))
            : resolveFetchTimeoutFinal;

        const finalResolved = await resolveCandidatesForServer(resolveSourceUrl, controller.signal, {
          playerv2Diag: pushDiag,
          parallelChildConcurrency: RESOLVE_CHILD_CONCURRENCY,
          allowSamePathServVariants: selectedServer === 3 || selectedServer === 4,
          livehdServPreference: isServer3Livehd ? "prefer0" : "all",
          server5Mode: selectedServer === 5 ? "final" : undefined,
          server5LandingLimit: selectedServer === 5 ? SERVER5_FINAL_LANDING_LIMIT : undefined,
          server5ChannelKeyLimit: selectedServer === 5 ? SERVER5_FINAL_CHANNEL_KEY_LIMIT : undefined,
          server5AllowSitemap: selectedServer === 5 ? false : undefined,
          server5SearchTerms: selectedServer === 5 ? [match?.home_team ?? "", match?.away_team ?? ""] : undefined,
          fetchTimeoutMs: server5FinalFetchTimeoutMs,
          fetchRetries: resolveFetchRetries,
          fetchRetryDelayMs: resolveFetchRetryDelayMs,
          onBatchCandidates: (batch, phase, batchProvenance) => {
            if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
            mergeCandidates(batch, batchProvenance);
            pushDiag(`resolve batch ${phase} +${batch.length}`);
          },
        });
        if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
        if (selectedServer === 3) mergeServer3Provenance(finalResolved.provenanceByKey);
        const finalList = finalResolved.candidates;
        const playableList =
          selectedServer === 5
            ? ([] as string[])
            : await expandCandidatesWithManifestVariants(finalList, {
              signal: controller.signal,
              timeoutMs: probeTimeoutMs,
              maxParents: 8,
              maxVariantsPerParent: 12,
              concurrency: EXPAND_VARIANTS_CONCURRENCY,
              pushDiag,
            });
        if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
        if (!cancel) {
          const mergedRawPrePolicy = dedupeUrls([...candidatesRef.current, ...fastMerged, ...finalList, ...playableList]);
          const mergedRaw =
            selectedServer === 5
              ? prioritizeServer5Candidates(mergedRawPrePolicy.filter((candidate) => isServer5AuthReadyCandidate(candidate)))
              : mergedRawPrePolicy;
          if (selectedServer === 5 && mergedRawPrePolicy.length !== mergedRaw.length) {
            pushDiag(`server5 scoped raw=${mergedRaw.length}/${mergedRawPrePolicy.length}`);
          }
          const maxChecks = Math.min(36, mergedRaw.length);
          let verified: string[] = [];
          if (selectedServer === 3 && isServer3Livehd) {
            const rawBuckets = splitServer3CandidatesByRootServ(mergedRaw, server3ProvenanceRef.current);
            const stage0Checks = Math.min(SERVER3_STAGE0_MAX_CHECKS, rawBuckets.bucket0.length);
            let stage0Verified: string[] = [];
            if (stage0Checks > 0) {
              stage0Verified = await filterPlayableCandidates(rawBuckets.bucket0, {
                signal: controller.signal,
                timeoutMs: Math.min(probeTimeoutMs, SERVER3_STAGE0_TIMEOUT_MS),
                maxChildChecks: SERVER3_STAGE0_MAX_CHILD_CHECKS,
                maxChecks: stage0Checks,
                concurrency: Math.min(4, PROBE_CONCURRENCY),
                pushDiag,
              });
              pushDiag(`server3 stage0 verified=${stage0Verified.length}/${stage0Checks}`);
              if (
                stage0Verified.length &&
                !cancel &&
                !controller.signal.aborted &&
                activeResolveIdRef.current === resolveId
              ) {
                hadPlayable = true;
                applyCandidatesPreservingSelection(stage0Verified);
                setPlayerError(null);
                setResolverError(null);
                resetRecoveryState();
                setResolverLoading(false);
                setServer3VerifiedAvailable(true);
              }
            }
            const maxChecks0 = Math.min(maxChecks, rawBuckets.bucket0.length);
            const verified0 = maxChecks0
              ? await filterPlayableCandidates(rawBuckets.bucket0, {
                signal: controller.signal,
                timeoutMs: probeTimeoutMs,
                maxChecks: maxChecks0,
                concurrency: Math.min(3, PROBE_CONCURRENCY),
                pushDiag,
              })
              : [];
            const remainingChecks = Math.max(0, maxChecks - maxChecks0);
            const maxChecks1 = Math.min(remainingChecks, rawBuckets.bucket1.length);
            const verified1 = maxChecks1
              ? await filterPlayableCandidates(rawBuckets.bucket1, {
                signal: controller.signal,
                timeoutMs: probeTimeoutMs,
                maxChecks: maxChecks1,
                concurrency: Math.min(3, PROBE_CONCURRENCY),
                pushDiag,
              })
              : [];

            pushDiag(`server3 bucket0 raw=${rawBuckets.bucket0.length} verified=${verified0.length}`);
            pushDiag(`server3 bucket1 raw=${rawBuckets.bucket1.length} verified=${verified1.length}`);
            if (verified0.length) pushDiag("server3 default->serv0");
            else if (rawBuckets.bucket1.length) pushDiag("server3 fallback->serv1");

            verified = dedupeUrls([...verified0, ...verified1]);
          } else if (selectedServer === 5) {
            const stage1Checks = Math.min(maxChecks, SERVER5_STAGE1_MAX_CHECKS);
            let stage1Verified: string[] = [];
            if (stage1Checks > 0) {
              stage1Verified = await filterPlayableCandidates(mergedRaw, {
                signal: controller.signal,
                timeoutMs: Math.min(probeTimeoutMs, SERVER5_STAGE1_TIMEOUT_MS),
                maxChildChecks: 1,
                maxChecks: stage1Checks,
                concurrency: Math.min(3, PROBE_CONCURRENCY),
                pushDiag,
              });
              stage1Verified = prioritizeServer5Candidates(stage1Verified);
              pushDiag(`server5 stage1 verified=${stage1Verified.length}/${stage1Checks}`);
              if (
                stage1Verified.length &&
                !cancel &&
                !controller.signal.aborted &&
                activeResolveIdRef.current === resolveId
              ) {
                hadPlayable = true;
                applyCandidatesPreservingSelection(stage1Verified);
                setServer5PrewarmCandidates(selectedUrl, stage1Verified);
                setPlayerError(null);
                setResolverError(null);
                resetRecoveryState();
                setResolverLoading(false);
              }
            }
            if (stage1Verified.length >= SERVER5_FAST_MIN_RESOLVED_CANDIDATES) {
              pushDiag("server5 stage2 skipped stage1-ready");
              verified = stage1Verified;
            } else {
              const stage1KeySet = new Set(
                stage1Verified.map((candidate) => canonicalizeUrl(candidate) || String(candidate || "").toLowerCase())
              );
              const stage2Input = mergedRaw.filter(
                (candidate) => !stage1KeySet.has(canonicalizeUrl(candidate) || String(candidate || "").toLowerCase())
              );
              const stage2Checks = stage1Verified.length
                ? Math.min(SERVER5_STAGE2_MAX_CHECKS_WHEN_STAGE1_HIT, stage2Input.length)
                : Math.min(SERVER5_STAGE2_MAX_CHECKS, stage2Input.length);
              let stage2Verified: string[] = [];
              if (stage2Checks > 0) {
                stage2Verified = await filterPlayableCandidates(stage2Input, {
                  signal: controller.signal,
                  timeoutMs: Math.min(probeTimeoutMs, SERVER5_STAGE2_TIMEOUT_MS),
                  maxChildChecks: 1,
                  maxChecks: stage2Checks,
                  concurrency: Math.min(4, PROBE_CONCURRENCY),
                  pushDiag,
                });
              }
              const collapsedStage2 = prioritizeServer5Candidates(stage2Verified);
              pushDiag(`server5 stage2 verified=${collapsedStage2.length}/${stage2Checks}`);
              verified = prioritizeServer5Candidates([...stage1Verified, ...collapsedStage2]);
            }
          } else {
            verified = await filterPlayableCandidates(mergedRaw, {
              signal: controller.signal,
              timeoutMs: probeTimeoutMs,
              maxChecks,
              concurrency: Math.min(3, PROBE_CONCURRENCY),
              pushDiag,
            });
          }
          const allowRawFallback = selectedServer === 1 || isServer2Playerv2;
          const mergedRawByPolicy =
            selectedServer === 3 && isServer3Livehd
              ? (() => {
                const buckets = splitServer3CandidatesByRootServ(mergedRaw, server3ProvenanceRef.current);
                return dedupeUrls([...buckets.bucket0, ...buckets.bucket1]);
              })()
              : mergedRaw;
          if (selectedServer === 3) {
            pushDiag(`server3 verified=${verified.length} raw=${mergedRawByPolicy.length}`);
            if (verified.length) setServer3VerifiedAvailable(true);
            else {
              if (candidatesRef.current.length) {
                pushDiag("server3 keep-previous-verified");
              } else {
                setServer3VerifiedAvailable(false);
                pushDiag("server3 disabled no-verified");
              }
            }
          }
          const keepExistingServer3 = selectedServer === 3 && !verified.length && candidatesRef.current.length > 0;
          const merged =
            selectedServer === 3
              ? (verified.length ? verified : (keepExistingServer3 ? candidatesRef.current : []))
              : (verified.length ? verified : (allowRawFallback ? mergedRawByPolicy : []));
          if (keepExistingServer3) pushDiag("server3 keep-playing-current");
          if (!verified.length && selectedServer === 1 && mergedRaw.length) {
            pushDiag("raw-fallback server1");
          }
          if (!verified.length && isServer2Playerv2 && mergedRaw.length) {
            pushDiag("probe fallback server2-playerv2 raw");
          }
          const mergedPreferred =
            repackPrimaryOnlyMode
              ? [selectedUrl]
              : isRepackPlaylistUrl(selectedUrl) && !repackBypassServersRef.current.has(selectedServer)
                ? dedupeUrls([selectedUrl, ...merged])
              : merged;
          if (isRepackPlaylistUrl(selectedUrl)) {
            const isLikelySeedableCandidate = (candidate: string) => {
              const underlying = String(toUnderlyingUrl(candidate) || candidate || "").trim().toLowerCase();
              if (!underlying) return false;
              if (isRepackPlaylistUrl(underlying)) return false;
              if (!isValidHttpUrl(underlying)) return false;
              if (underlying.includes(".mpd")) return false;
              if (underlying.includes("/dash/") && !underlying.includes(".m3u8")) return false;
              return (
                underlying.includes(".m3u8") ||
                /\/hls\/|\/live\/|\/playlist\/|\/manifest\/|\/kooora\//i.test(underlying)
              );
            };
            const pickBestSeedCandidate = (pool: string[], sourceForSeed: string) => {
              const sourceRaw = String(sourceForSeed || "").trim();
              const sourceCanonical = canonicalizeUrl(sourceRaw) || sourceRaw.toLowerCase();
              const nowSec = Math.floor(Date.now() / 1000);
              const badSeedSet = badRepackSeedCandidatesByServerRef.current[selectedServer] || new Set<string>();
              let sourceHost = "";
              try {
                sourceHost = new URL(sourceRaw).hostname.toLowerCase();
              } catch { }
              let best = "";
              let bestScore = Number.NEGATIVE_INFINITY;
              for (const candidate of dedupeUrls(pool || [])) {
                if (!isLikelySeedableCandidate(candidate)) continue;
                const underlyingRaw = String(toUnderlyingUrl(candidate) || candidate || "").trim();
                const underlying = underlyingRaw.toLowerCase();
                const seedKey = canonicalizeUrl(underlyingRaw) || underlying;
                if (seedKey && badSeedSet.has(seedKey)) continue;
                let score = 0;
                if (underlying.includes(".m3u8")) score += 140;
                if (/\/hls\/|\/live\/|\/playlist\/|\/manifest\/|\/kooora\//i.test(underlying)) score += 90;
                const protectedTarget =
                  underlying.includes("yallashot.us") ||
                  underlying.includes("yallashoot") ||
                  underlying.includes("/kooora/") ||
                  /[?&](?:token|sid|nonce|ts)=/i.test(underlying);
                try {
                  const urlObj = new URL(underlyingRaw);
                  const token = String(urlObj.searchParams.get("token") || "").trim();
                  const sid = String(urlObj.searchParams.get("sid") || "").trim();
                  const tsRaw = String(urlObj.searchParams.get("ts") || "").trim();
                  const tsVal = Number.parseInt(tsRaw, 10);
                  const pathname = String(urlObj.pathname || "").toLowerCase();
                  const qualityTagged = /(?:[_-])(?:\d{3,4}p|sd|hd|fhd|uhd)\.m3u8$/i.test(pathname);
                  if (qualityTagged) score += 190;
                  else if (pathname.endsWith(".m3u8")) score -= 70;
                  if ((token || sid) && Number.isFinite(tsVal) && tsVal > 0) {
                    const ageSec = Math.max(0, nowSec - tsVal);
                    if (ageSec > 180) continue;
                    if (ageSec <= 90) score += Math.max(40, 260 - ageSec * 2);
                    else score -= 80;
                  } else if (token || sid) {
                    score -= 35;
                  }
                } catch { }
                if (candidate.startsWith("/api/embed-proxy?")) {
                  try {
                    const proxyUrl = new URL(candidate, "http://localhost");
                    const depth = Number.parseInt(String(proxyUrl.searchParams.get("depth") || "0"), 10);
                    if (depth >= 1) score += 60;
                    else score -= 20;
                  } catch { }
                }
                if (protectedTarget) {
                  if (candidate.startsWith("/api/embed-proxy?")) score += 320;
                  else score -= 650;
                }
                const refUrl = getProxyRefUrlFromCandidate(candidate);
                const refCanonical = canonicalizeUrl(refUrl) || String(refUrl || "").trim().toLowerCase();
                if (sourceCanonical && refCanonical && refCanonical === sourceCanonical) score += 520;
                if (sourceHost) {
                  if (refCanonical.includes(sourceHost)) score += 180;
                  try {
                    const uHost = new URL(underlyingRaw).hostname.toLowerCase();
                    if (uHost === sourceHost) score += 260;
                    else if (uHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${uHost}`)) score += 190;
                  } catch { }
                }
                if (candidate.startsWith("/api/embed-proxy?")) score += 25;
                if (score > bestScore) {
                  bestScore = score;
                  best = candidate;
                }
              }
              return best;
            };
            const sourceForSeed = String(selectedFallbackUrl || selectedUrl || "").trim();
            let seedSourceUrl = sourceForSeed;
            let seedPool = dedupeUrls([...verified, ...mergedRaw, ...seedCandidates, ...initialCandidates]);
            let seedFrom = pickBestSeedCandidate(seedPool, sourceForSeed);
            if (!seedFrom && repackPrimaryOnlyMode && selectedFallbackUrl && isValidHttpUrl(selectedFallbackUrl)) {
              try {
                const seedResolved = await resolveCandidatesForServer(selectedFallbackUrl, controller.signal, {
                  playerv2Diag: pushDiag,
                  parallelChildConcurrency: Math.min(2, RESOLVE_CHILD_CONCURRENCY),
                  allowSamePathServVariants: selectedServer === 3 || selectedServer === 4,
                  livehdServPreference: isServer3Livehd ? "prefer0" : "all",
                  maxPlayerPages: isServer2Playerv2 ? 1 : 3,
                  maxDeepCandidates: isServer2Playerv2 ? 4 : 5,
                  maxPlayerv2Pool: isServer2Playerv2 ? 1 : 0,
                  fetchTimeoutMs: Math.min(resolveFetchTimeoutFast, 3600),
                  fetchRetries: 0,
                  fetchRetryDelayMs: 0,
                });
                seedPool = dedupeUrls([...seedPool, ...seedResolved.candidates]);
                seedFrom = pickBestSeedCandidate(seedPool, sourceForSeed);
                pushDiag(`repack seed-resolve s${selectedServer} +${seedResolved.candidates.length}`);
              } catch (e: unknown) {
                pushDiag(`repack seed-resolve s${selectedServer} fail=${e instanceof Error ? e.message : String(e)}`);
              }
            }
            if (seedFrom) {
              const seedCandidateForAgent = (() => {
                if (seedFrom.startsWith("/api/embed-proxy?")) return seedFrom;
                const proxied = toEmbedProxyUrl(seedFrom, seedSourceUrl || sourceForSeed || seedFrom);
                return proxied || seedFrom;
              })();
              void requestRepackSeed({
                serverId: selectedServer,
                sourceUrl: seedSourceUrl,
                sourceCandidate: seedCandidateForAgent,
              });
            }
          }
          if (mergedRaw.length) pushDiag(`probe ok ${mergedPreferred.length}/${mergedRaw.length}`);
          applyCandidatesPreservingSelection(mergedPreferred);
          if (selectedServer === 5 && merged.length) {
            setServer5PrewarmCandidates(selectedUrl, merged);
          }
          if (mergedPreferred.length && !disableResolveCache) setCachedResolveCandidates(resolveSourceUrl, mergedPreferred);
          if (!mergedPreferred.length) {
            const keepPlayerv2Cache = selectedServer === 2 && isPlayerv2LikeUrl(resolveSourceUrl);
            if (!keepPlayerv2Cache) clearCachedResolveCandidates(resolveSourceUrl);
            setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
            if (selectedServer !== 3) scheduleResolveRecovery("resolver-empty");
            else resetRecoveryState();
          } else {
            hadPlayable = true;
            setPlayerError(null);
            setResolverError(null);
            resetRecoveryState();
          }
        }
      } catch (e: unknown) {
        if (!cancel && !(e instanceof Error && e.name === "AbortError")) {
          if (!hadPlayable) {
            const rawErrorMessage = e instanceof Error ? e.message : "فشل استخراج المصادر.";
            const isProbeTimeout = /probe-timeout/i.test(rawErrorMessage);
            // Always suppress probe timeouts for retry, regardless of server
            if (isProbeTimeout) {
              pushDiag(`resolver probe-timeout server${selectedServer}`);
              setResolverError(null);
            } else {
              setResolverError(rawErrorMessage);
            }
            if (selectedServer === 3) {
              setServer3VerifiedAvailable(false);
              pushDiag("server3 disabled no-verified");
            }
            if (selectedServer !== 3) {
              const immediate = isProbeTimeout; // Retry immediately heavily favored for timeouts
              scheduleResolveRecovery("resolver-error", immediate);
            } else {
              resetRecoveryState();
            }
          } else {
            pushDiag(`resolve background error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        if (!cancel && activeResolveIdRef.current === resolveId) {
          setResolverLoading(false);
          resolveLockRef.current = false;
          const pendingKick = pendingResolveKickReasonRef.current;
          if (pendingKick) {
            pendingResolveKickReasonRef.current = null;
            lastResolveKickRef.current = Date.now();
            setResolveRevision((prev) => prev + 1);
            pushDiag(`resolve bump (${pendingKick})`);
          }
        }
      }
    })();
    return () => {
      cancel = true;
      controller.abort();
      if (activeResolveIdRef.current === resolveId) resolveLockRef.current = false;
    };
  }, [
    selectedUrl,
    selectedServer,
    shouldBlockStream,
    pushDiag,
    resolveRevision,
    scheduleResolveRecovery,
    resetRecoveryState,
    applyCandidatesPreservingSelection,
    mergeServer3Provenance,
    runtimeServer5Url,
    warmServer5PrewarmCandidates,
    match?.stream_url_5,
    match?.home_team,
    match?.away_team,
    selectedFallbackUrl,
    requestRepackSeed,
  ]);

  const selectedHlsUrl = candidates[selectedCandidate] || "";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tryResume = () => {
      if (shouldBlockStream || !selectedHlsUrl) return;
      if (userPausedRef.current) return;

      const progressingRecently = Date.now() - lastProgressAtRef.current < 1500;
      if (!video.paused && progressingRecently) return;

      try {
        hlsInstance?.startLoad();
      } catch {}
      try {
        video.play().catch(() => {});
      } catch {}
      lastProgressAtRef.current = Date.now();
    };

    const onVisibilityChange = () => {
      if (!document.hidden) tryResume();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted || video.paused) tryResume();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [hlsInstance, selectedHlsUrl, shouldBlockStream]);
  const candidateGroups = useMemo(() => groupCandidates(candidates), [candidates]);
  const activeCandidateGroupIndex = useMemo(
    () => candidateGroups.findIndex((g) => g.members.includes(selectedCandidate)),
    [candidateGroups, selectedCandidate]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancel = false;
    let hls: Hls | null = null;
    let p2pEngine: P2PEngineInstance | null = null;
    let detachP2PListeners: (() => void) | null = null;
    const current = selectedCandidate;
    const currentCandidateKey = candidateFailureKey(selectedHlsUrl);
    const useFastFailover = isFastFailoverServer(selectedServer);
    const isP2PPlayback =
      P2P_FEATURE_FLAG && selectedServer !== 5 && p2pEnabledServerSet.has(selectedServer) && selectedServer <= 4;
    if (!repackPlaybackStartedAtByServerRef.current[selectedServer]) {
      repackPlaybackStartedAtByServerRef.current[selectedServer] = Date.now();
    }
    const p2pTuning = getP2PProfileHlsTuning(P2P_PROFILE);
    const server5PlayerAuthHeaders =
      selectedServer === 5 ? buildServer5ProxyAuthHeadersFromCandidate(selectedHlsUrl) : ({} as Record<string, string>);
    let freezeTriggered = false;
    let server5VisualStarted = false;
    let server5StartupGraceUsed = false;
    const playbackAttemptStartedAt = Date.now();
    let loadingOverlayTimer: number | null = null;
    let startupNoFrameTimer: number | null = null;
    const timeoutHandles: number[] = [];
    const queueTimeout = (fn: () => void, delayMs: number) => {
      const id = window.setTimeout(() => {
        if (cancel) return;
        fn();
      }, delayMs);
      timeoutHandles.push(id);
      return id;
    };
    const clearServer5StartupNoFrameTimer = () => {
      if (startupNoFrameTimer !== null) {
        window.clearTimeout(startupNoFrameTimer);
        startupNoFrameTimer = null;
      }
    };
    const markServer5VisualStart = () => {
      if (selectedServer !== 5 || server5VisualStarted) return;
      server5VisualStarted = true;
      clearServer5StartupNoFrameTimer();
    };
    const getServer5DecodedFrameCount = () => {
      try {
        const quality =
          typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
        const fromQuality = Number(quality?.totalVideoFrames ?? 0);
        if (Number.isFinite(fromQuality) && fromQuality > 0) return fromQuality;
      } catch {}
      const fallbackDecoded = Number(
        (video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount ?? 0
      );
      return Number.isFinite(fallbackDecoded) ? fallbackDecoded : 0;
    };
    const hasServer5VisualStart = () => {
      const hasFrameDimensions = video.videoWidth > 0 && video.videoHeight > 0;
      const decodedFrames = getServer5DecodedFrameCount();
      if (decodedFrames > 0) return true;
      return hasFrameDimensions && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    };
    const scheduleServer5StartupNoFrameWatchdog = () => {
      if (selectedServer !== 5 || startupNoFrameTimer !== null) return;
      startupNoFrameTimer = window.setTimeout(() => {
        if (cancel || server5VisualStarted) return;
        if (hasServer5VisualStart()) {
          markServer5VisualStart();
          return;
        }
        try { hls?.startLoad(); } catch { }
        try { video.play().catch(() => { }); } catch { }
        queueTimeout(() => {
          if (cancel || server5VisualStarted) return;
          if (hasServer5VisualStart()) {
            markServer5VisualStart();
            return;
          }
          const hasBuffered = (() => {
            try {
              return video.buffered.length > 0 && video.buffered.end(video.buffered.length - 1) > 0;
            } catch {
              return false;
            }
          })();
          if (!server5StartupGraceUsed && selectedServer === 5 && (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || hasBuffered)) {
            server5StartupGraceUsed = true;
            pushDiag("server5 startup grace");
            queueTimeout(() => {
              if (cancel || server5VisualStarted) return;
              if (hasServer5VisualStart()) {
                markServer5VisualStart();
                return;
              }
              pushDiag("server5 startup no-frame");
              moveNext("startup-no-frame");
            }, Math.max(1200, SERVER5_STARTUP_NO_FRAME_RECHECK_MS));
            return;
          }
          pushDiag("server5 startup no-frame");
          moveNext("startup-no-frame");
        }, SERVER5_STARTUP_NO_FRAME_RECHECK_MS);
      }, SERVER5_STARTUP_NO_FRAME_TIMEOUT_MS);
    };
    const clearStallWatchdog = () => {
      if (stallTimerRef.current !== null) {
        window.clearInterval(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
    const markProgress = () => {
      const currentTime = Number(video.currentTime);
      if (Number.isFinite(currentTime) && currentTime >= 0) lastProgressRef.current = currentTime;
      lastProgressAtRef.current = Date.now();
    };
    const clearLoadingOverlayTimer = () => {
      if (loadingOverlayTimer !== null) {
        window.clearTimeout(loadingOverlayTimer);
        loadingOverlayTimer = null;
      }
    };
    const showPlayerLoadingDelayed = () => {
      if (loadingOverlayTimer !== null) return;
      loadingOverlayTimer = window.setTimeout(() => {
        loadingOverlayTimer = null;
        if (cancel) return;
        setPlayerLoading(true);
      }, PLAYER_LOADING_OVERLAY_DELAY_MS);
    };
    const hidePlayerLoading = () => {
      clearLoadingOverlayTimer();
      setPlayerLoading(false);
    };
    let autoplayRetryUsed = false;
    let lastRecoveryAttemptAt = 0;
    let stallFreezeCount = 0;
    let autoAudioSyncAttempted = false;
    let autoAudioSyncTimer: number | null = null;
    const p2pStats = {
      p2pBytes: 0,
      httpBytes: 0,
      uploadedBytes: 0,
      peerCount: 0,
      lastLogAt: 0,
    };
    const syncVolumeUiState = () => {
      try {
        video.dispatchEvent(new Event("volumechange"));
      } catch { }
    };
    const ensureLoudAudio = () => {
      video.volume = 1;
      video.muted = false;
      video.defaultMuted = false;
      video.removeAttribute("muted");
      syncVolumeUiState();
    };
    const keepMutedAutoplay = () => {
      video.muted = true;
      video.defaultMuted = true;
      video.setAttribute("muted", "");
      syncVolumeUiState();
    };
    const clearAutoAudioSyncTimer = () => {
      if (autoAudioSyncTimer !== null) {
        window.clearTimeout(autoAudioSyncTimer);
        autoAudioSyncTimer = null;
      }
    };
    const isAudibleAutoplayAllowed = () => {
      const nav = navigator as Navigator & {
        getAutoplayPolicy?: (target?: HTMLMediaElement | string) => string;
      };
      const getter = nav.getAutoplayPolicy;
      if (typeof getter !== "function") return false;
      try {
        return getter(video) === "allowed";
      } catch {
        return false;
      }
    };
    const scheduleAutoAudioSync = () => {
      if (!AUTO_AUDIO_SYNC_ON_START) return;
      if (autoAudioSyncAttempted) return;
      if (cancel || userPausedRef.current) return;
      if (video.paused) return;
      autoAudioSyncAttempted = true;
      clearAutoAudioSyncTimer();
      autoAudioSyncTimer = window.setTimeout(() => {
        autoAudioSyncTimer = null;
        if (cancel || userPausedRef.current) return;
        if (video.paused) return;
        if (!isAudibleAutoplayAllowed()) {
          pushDiag("audio-sync skipped policy!=allowed");
          return;
        }
        try {
          ensureLoudAudio();
          if (video.paused) {
            keepMutedAutoplay();
            pushDiag("audio-sync reverted muted (pause-risk)");
            return;
          }
          pushDiag("audio-sync enabled");
        } catch {
          keepMutedAutoplay();
          pushDiag("audio-sync reverted muted");
        }
      }, 350);
    };
    const playMutedSafely = () => {
      if (cancel) return;
      keepMutedAutoplay();
      video.play()
        .catch(() => {
          if (cancel || autoplayRetryUsed) return;
          autoplayRetryUsed = true;
          queueTimeout(() => {
            if (cancel) return;
            keepMutedAutoplay();
            try {
              video.play().catch(() => { });
            } catch { }
          }, 250);
        });
    };
    const getBufferedAheadSeconds = () => {
      try {
        const t = Number(video.currentTime);
        if (!Number.isFinite(t)) return 0;
        const ranges = video.buffered;
        for (let i = 0; i < ranges.length; i += 1) {
          const start = ranges.start(i);
          const end = ranges.end(i);
          if (t >= start - 0.05 && t <= end + 0.05) return Math.max(0, end - t);
        }
        return 0;
      } catch {
        return 0;
      }
    };
    const logP2PStats = (force = false) => {
      if (!isP2PPlayback) return;
      const now = Date.now();
      if (!force && now - p2pStats.lastLogAt < 5000) return;
      p2pStats.lastLogAt = now;
      const totalDownloadBytes = p2pStats.p2pBytes + p2pStats.httpBytes;
      const ratio = totalDownloadBytes > 0 ? Math.round((p2pStats.p2pBytes / totalDownloadBytes) * 100) : 0;
      pushDiag(
        `p2p peers=${p2pStats.peerCount} p2pBytes=${p2pStats.p2pBytes} httpBytes=${p2pStats.httpBytes} upBytes=${p2pStats.uploadedBytes} p2pRatio=${ratio}%`
      );
    };
    const trackRepackFallback = (reason: string, fromCandidate?: string, toCandidate?: string) => {
      if (!isRepackPlaylistUrl(String(fromCandidate || ""))) return;
      if (!toCandidate || isRepackPlaylistUrl(String(toCandidate || ""))) return;
      repackFallbackReasonByServerRef.current[selectedServer] = reason || "repack-fallback";
      pushDiag(`repack fallback s${selectedServer} reason=${reason}`);
      reportRepackPlaybackDiag("fallback", selectedServer, String(fromCandidate || ""));
    };
    const seedRepackFromCurrentPlayback = () => {
      const candidate = String(selectedHlsUrl || "").trim();
      if (!candidate || isRepackPlaylistUrl(candidate)) return;
      const fallbackSource =
        isRepackPlaylistUrl(selectedUrl) && selectedFallbackUrl ? selectedFallbackUrl : selectedUrl;
      const sourceUrl = String(fallbackSource || "").trim();
      if (!sourceUrl || !isValidHttpUrl(toUnderlyingUrl(sourceUrl) || sourceUrl)) return;
      void requestRepackSeed({
        serverId: selectedServer,
        sourceUrl,
        sourceCandidate: candidate,
      });
    };
    const requestSoftRecovery = (reason = "generic") => {
      if (userPausedRef.current) return;
      const now = Date.now();
      const recoveryThrottleMs = isP2PPlayback
        ? P2P_RECOVERY_THROTTLE_MS
        : (isRepackPlaylistUrl(selectedHlsUrl) ? 5000 : 3000);
      if (now - lastRecoveryAttemptAt < recoveryThrottleMs) return;
      const currentTime = Number(video.currentTime);
      if (
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        Number.isFinite(currentTime) &&
        currentTime > lastProgressRef.current + 0.05
      ) {
        return;
      }
      lastRecoveryAttemptAt = now;
      if (isP2PPlayback) pushDiag(`soft-recovery (${reason})`);
      try { hls?.startLoad(); } catch { }
      queueTimeout(() => {
        if (cancel) return;
        if (userPausedRef.current) return;
        if (!video.paused) return;
        try {
          video.play().catch(() => { });
        } catch { }
      }, 150);
    };
    const applyServer5ProxyAuthToXhr = (xhr: XMLHttpRequest, requestUrl: string) => {
      if (!server5PlayerAuthHeaders || !Object.keys(server5PlayerAuthHeaders).length) return;
      const raw = String(requestUrl || "");
      if (!raw.includes("/api/embed-proxy?")) return;
      for (const [key, value] of Object.entries(server5PlayerAuthHeaders)) {
        if (!value) continue;
        try {
          xhr.setRequestHeader(key, value);
        } catch { }
      }
    };
    const moveNext = (reason: string) => {
      const total = candidatesRef.current.length;
      setResolverError(null);
      const activeIndex = selectedCandidateRef.current;
      if (activeIndex + 1 < total) {
        if (selectedServer === 3) {
          const now = Date.now();
          const windowState = server3AutoSwitchWindowRef.current;
          if (now - windowState.windowStart > SERVER3_AUTOSWITCH_WINDOW_MS) {
            windowState.windowStart = now;
            windowState.count = 0;
          }
          windowState.count += 1;
          if (windowState.count > SERVER3_AUTOSWITCH_LIMIT) {
            pushDiag("server3 autoswitch-guard stop");
            setPlayerError("تم إيقاف التحويل التلقائي مؤقتًا لتفادي الدوران. اختر مصدرًا آخر.");
            setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
            hidePlayerLoading();
            return;
          }
        }
        const nextIndex = activeIndex + 1;
        const activeCandidate = candidatesRef.current[activeIndex] || "";
        const nextCandidate = candidatesRef.current[nextIndex] || "";
        trackRepackFallback(reason, activeCandidate, nextCandidate);
        selectedCandidateRef.current = nextIndex;
        setSelectedCandidate(nextIndex);
        setPlayerError(`تعثر المصدر الحالي (${reason})، جاري التحويل تلقائيًا للمصدر التالي.`);
      } else {
        if (selectedServer === 5) {
          const elapsedMs = Date.now() - playbackAttemptStartedAt;
          const hasVisual = server5VisualStarted || hasServer5VisualStart();
          const canFinalize = elapsedMs >= SERVER5_FINAL_ERROR_MIN_MS && !hasVisual;
          if (canFinalize) {
            setPlayerError("فشل تشغيل كل مصادر HLS الداخلية.");
            pushDiag("server5 final exhausted");
          } else {
            setPlayerError("جاري التحضير...");
          }
          scheduleResolveRecovery(`player-exhausted:${reason}`, true);
        } else if (selectedServer === 3) {
          setPlayerError("فشل تشغيل كل مصادر HLS الداخلية.");
          applyCandidatesPreservingSelection([]);
          setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
          resetRecoveryState();
        } else {
          setPlayerError("فشل تشغيل كل مصادر HLS الداخلية.");
          scheduleResolveRecovery(`player-exhausted:${reason}`, true);
        }
      }
      hidePlayerLoading();
    };
    const reset = () => {
      ignorePauseTrackingRef.current = true;
      try { video.pause(); } catch { }
      video.removeAttribute("src");
      video.load();
      queueTimeout(() => {
        ignorePauseTrackingRef.current = false;
      }, 0);
    };
    clearStallWatchdog();
    reset();
    hidePlayerLoading();
    setPlayerError(null);
    if (shouldBlockStream || !selectedHlsUrl) return;
    userPausedRef.current = false;
    setPlayerLoading(true);
    scheduleServer5StartupNoFrameWatchdog();
    video.volume = 1;
    keepMutedAutoplay();
    markProgress();
    let fatalRetries = 0;
    let repackLevelFingerprint = "";
    let repackLevelChangedAt = Date.now();
    let lastLevelStartSn: number | null = null;
    let nativeStartupReported = false;
    const onLoaded = () => {
      if (cancel) return;
      playMutedSafely();
      markProgress();
      if (nativeHlsPlayback && !nativeStartupReported) {
        nativeStartupReported = true;
        if (isRepackPlaylistUrl(selectedHlsUrl)) {
          repackFallbackReasonByServerRef.current[selectedServer] = "none";
        } else {
          seedRepackFromCurrentPlayback();
        }
        reportRepackPlaybackDiag("native-loaded", selectedServer, selectedHlsUrl);
      }
      if (hasServer5VisualStart()) markServer5VisualStart();
      if (selectedServer !== 5 || hasServer5VisualStart()) hidePlayerLoading();
    };
    const onWaiting = () => {
      if (cancel) return;
      const server5RecentProgress = selectedServer === 5 && Date.now() - lastProgressAtRef.current < 2500;
      if (!server5RecentProgress && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) showPlayerLoadingDelayed();
      const stalledFor = Date.now() - lastProgressAtRef.current;
      const bufferedAhead = getBufferedAheadSeconds();
      if (!isP2PPlayback) {
        if (
          stalledFor >= REPACK_HLS_WAITING_RECOVERY_MIN_STALL_MS &&
          bufferedAhead <= REPACK_HLS_WAITING_RECOVERY_MAX_BUFFER_AHEAD_S
        ) {
          requestSoftRecovery("waiting");
        }
        return;
      }
      if (
        stalledFor >= P2P_WAITING_RECOVERY_MIN_STALL_MS &&
        video.readyState <= HTMLMediaElement.HAVE_CURRENT_DATA &&
        bufferedAhead <= P2P_WAITING_RECOVERY_MAX_BUFFER_AHEAD_S
      ) {
        requestSoftRecovery("waiting-p2p");
      }
    };
          const onPlaying = () => {
      if (cancel) return;
      userPausedRef.current = false;
      if (selectedServer === 3) {
        server3AutoSwitchWindowRef.current = { windowStart: 0, count: 0 };
      }
      freezeTriggered = false;
      stallFreezeCount = 0;
      markProgress();
      if (hasServer5VisualStart()) markServer5VisualStart();
      if (selectedServer === 5 && selectedUrl && isValidHttpUrl(selectedUrl) && selectedHlsUrl) {
        const existing = getServer5PrewarmCandidates(selectedUrl);
        setServer5PrewarmCandidates(selectedUrl, [selectedHlsUrl, ...existing]);
      }
            resetRecoveryState();
            if (selectedServer !== 5 || hasServer5VisualStart()) hidePlayerLoading();
            setPlayerError(null);
            if (R2_STRICT_MODE) setStrictPlaybackDiag((prev) => (prev ? null : prev));
            setResolverError(null);
            if (useFastFailover) clearCandidateFailureMarks(selectedServer, selectedHlsUrl);
            scheduleAutoAudioSync();
          };
    const onTimeUpdate = () => {
      markProgress();
      const server5HasVisual = selectedServer === 5 && hasServer5VisualStart();
      if (server5HasVisual) markServer5VisualStart();
            const nonServer5Ready = selectedServer !== 5 && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
            if (!video.paused && (nonServer5Ready || server5HasVisual)) {
              hidePlayerLoading();
            }
            if (R2_STRICT_MODE && !video.paused && (nonServer5Ready || server5HasVisual)) {
              setPlayerError((prev) => (prev ? null : prev));
              setStrictPlaybackDiag((prev) => (prev ? null : prev));
            }
            const progressed = Number(video.currentTime);
            if (Number.isFinite(progressed) && progressed > 0.2) {
              userPausedRef.current = false;
        scheduleAutoAudioSync();
      }
    };
    const onPause = () => {
      if (cancel) return;
      if (ignorePauseTrackingRef.current) return;
      const isSilentPlayback = video.muted || Number(video.volume) <= 0.0001;
      const likelyUserPause =
        !isSilentPlayback &&
        !video.seeking &&
        !document.hidden &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      if (likelyUserPause) {
        userPausedRef.current = true;
        return;
      }
      // Pause while muted is frequently policy/network side-effect, not explicit user intent.
      userPausedRef.current = false;
      queueTimeout(() => {
        if (cancel || userPausedRef.current) return;
        if (!video.paused) return;
        try { hls?.startLoad(); } catch { }
        playMutedSafely();
      }, 160);
    };
    const onCanPlay = () => {
      if (cancel) return;
      if (userPausedRef.current) return;
      if (video.paused) playMutedSafely();
    };
    const nativeHlsPlayback = shouldUseNativeHls(video);
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("loadedmetadata", onCanPlay);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    if (nativeHlsPlayback) {
      video.src = selectedHlsUrl;
      video.load();
      playMutedSafely();
    } else if (Hls.isSupported()) {
      const isServer5Playback = selectedServer === 5;
      const isRepackPlayback = isRepackPlaylistUrl(selectedHlsUrl);
      const baseHlsConfig = {
        enableWorker: true,
        xhrSetup: (xhr: XMLHttpRequest, requestUrl: string) => {
          applyServer5ProxyAuthToXhr(xhr, requestUrl);
          xhr.addEventListener("loadend", () => {
            const cacheStatus = String(xhr.getResponseHeader("cf-cache-status") || "").trim().toUpperCase();
            if (!cacheStatus) return;
            const prev = String(repackCacheStatusByServerRef.current[selectedServer] || "");
            if (prev !== cacheStatus) {
              repackCacheStatusByServerRef.current[selectedServer] = cacheStatus;
              pushDiag(`cache-status s${selectedServer} ${cacheStatus}`);
            }
          });
        },
        lowLatencyMode: false,
        capLevelToPlayerSize: false,
        backBufferLength: isServer5Playback ? SERVER5_HLS_BACK_BUFFER_LENGTH : 20,
        maxBufferLength: isServer5Playback
          ? SERVER5_HLS_MAX_BUFFER_LENGTH
          : (isRepackPlayback ? REPACK_HLS_MAX_BUFFER_LENGTH : (isP2PPlayback ? p2pTuning.maxBufferLength : 18)),
        maxMaxBufferLength: isServer5Playback
          ? SERVER5_HLS_MAX_MAX_BUFFER_LENGTH
          : (isRepackPlayback ? REPACK_HLS_MAX_MAX_BUFFER_LENGTH : 40),
        maxBufferSize: isP2PPlayback ? p2pTuning.maxBufferSize : 60 * 1000 * 1000,
        liveSyncDurationCount: isServer5Playback
          ? SERVER5_HLS_LIVE_SYNC_COUNT
          : (isRepackPlayback ? REPACK_HLS_LIVE_SYNC_COUNT : (isP2PPlayback ? p2pTuning.liveSyncDurationCount : 2)),
        liveMaxLatencyDurationCount: isServer5Playback
          ? SERVER5_HLS_LIVE_MAX_LATENCY_COUNT
          : (isRepackPlayback
            ? REPACK_HLS_LIVE_MAX_LATENCY_COUNT
            : (isP2PPlayback ? p2pTuning.liveMaxLatencyDurationCount : 6)),
        maxLiveSyncPlaybackRate: 1,
        startPosition: -1,
        startFragPrefetch: true,
        maxBufferHole: 1.2,
        highBufferWatchdogPeriod: 2,
        manifestLoadingMaxRetry: isServer5Playback ? SERVER5_HLS_MANIFEST_RETRIES : 6,
        levelLoadingMaxRetry: isServer5Playback ? SERVER5_HLS_LEVEL_RETRIES : 6,
        fragLoadingMaxRetry: isServer5Playback ? SERVER5_HLS_FRAG_RETRIES : 8,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.7,
      };
      const attachHlsInstance = (instance: Hls) => {
        hls = instance;
        setHlsInstance(instance);
        instance.on(Hls.Events.MEDIA_ATTACHED, () => instance.loadSource(selectedHlsUrl));
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancel) return;
          const defaultLevel = pickDefaultHlsLevel(instance.levels || []);
          if (defaultLevel >= 0) {
            // Start around 480p for faster first paint while keeping ABR on Auto.
            instance.startLevel = defaultLevel;
            instance.nextAutoLevel = defaultLevel;
          }
          markProgress();
          resetRecoveryState();
          if (selectedServer !== 5 || hasServer5VisualStart()) hidePlayerLoading();
          setPlayerError(null);
          setResolverError(null);
          if (useFastFailover) clearCandidateFailureMarks(selectedServer, selectedHlsUrl);
          if (isRepackPlaylistUrl(selectedHlsUrl)) {
            repackFallbackReasonByServerRef.current[selectedServer] = "none";
            repackRecoveryErrorCountByServerRef.current[selectedServer] = 0;
          } else {
            seedRepackFromCurrentPlayback();
          }
          reportRepackPlaybackDiag("manifest", selectedServer, selectedHlsUrl);
          if (R2_STRICT_MODE) {
            setStrictPlaybackDiag((prev) => (prev === null ? prev : null));
          }
          playMutedSafely();
        });
        instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          if (cancel) return;
          if (!isRepackPlaylistUrl(selectedHlsUrl)) return;
          const details = (data as { details?: { startSN?: number; endSN?: number; fragments?: Array<{ relurl?: string; url?: string }> } })
            ?.details;
          const startSN = Number(details?.startSN);
          if (Number.isFinite(startSN)) {
            if (lastLevelStartSn !== null && startSN < lastLevelStartSn && R2_STRICT_MODE) {
              const driftMsg = `sequence-backtrack ${lastLevelStartSn} -> ${startSN}`;
              setStrictPlaybackDiag((prev) => (prev === driftMsg ? prev : driftMsg));
              pushDiag(`strict diag ${driftMsg}`);
            }
            lastLevelStartSn = startSN;
          }
          let fingerprint = "";
          const endSN = Number(details?.endSN);
          if (Number.isFinite(startSN) || Number.isFinite(endSN)) {
            fingerprint = `${Number.isFinite(startSN) ? startSN : "na"}:${Number.isFinite(endSN) ? endSN : "na"}`;
          } else if (Array.isArray(details?.fragments) && details.fragments.length) {
            fingerprint = details.fragments
              .slice(-2)
              .map((frag) => String(frag?.relurl || frag?.url || "").trim())
              .filter(Boolean)
              .join("|");
          }
          if (!fingerprint) return;

          const now = Date.now();
          if (!repackLevelFingerprint || repackLevelFingerprint !== fingerprint) {
            repackLevelFingerprint = fingerprint;
            repackLevelChangedAt = now;
            return;
          }
          const idleMs = now - repackLevelChangedAt;
          if (idleMs < REPACK_STALE_PLAYLIST_MAX_IDLE_MS) return;
          const sinceProgressMs = now - lastProgressAtRef.current;
          if (sinceProgressMs < REPACK_STALE_PROGRESS_GUARD_MS) return;
          if (repackBypassServersRef.current.has(selectedServer)) return;
          if (!EMBED_FALLBACK_ENABLED) {
            pushDiag(`repack stale-manifest s${selectedServer} no-fallback`);
            const staleErrCount = (repackRecoveryErrorCountByServerRef.current[selectedServer] || 0) + 1;
            repackRecoveryErrorCountByServerRef.current[selectedServer] = staleErrCount;
            const failedSeedKey = String(lastRepackSeedCandidateKeyByServerRef.current[selectedServer] || "").trim();
            if (failedSeedKey) {
              const badSet = badRepackSeedCandidatesByServerRef.current[selectedServer] || new Set<string>();
              badSet.add(failedSeedKey);
              badRepackSeedCandidatesByServerRef.current[selectedServer] = badSet;
            }
            if (idNum) {
              const seedPrefix = `${idNum}:${selectedServer}:`;
              for (const key of Array.from(repackSeedSentRef.current.keys())) {
                if (key.startsWith(seedPrefix)) repackSeedSentRef.current.delete(key);
              }
            }
            if (staleErrCount >= 3) {
              setPlayerError("تحديث R2 متوقف مؤقتًا... جاري إعادة المحاولة تلقائيًا.");
            } else if (staleErrCount >= 2) {
              setPlayerError("تذبذب مؤقت في تحديث R2... جاري التثبيت.");
            } else {
              setPlayerError(null);
            }
            requestSoftRecovery("repack-stale-no-fallback");
            if (staleErrCount >= 2) {
              scheduleResolveRecovery("repack-stale-no-fallback", true);
            }
            return;
          }

          pushDiag(`repack stale-manifest s${selectedServer} idle=${idleMs}ms`);
          repackBypassServersRef.current.add(selectedServer);
          setRepackBypassVersion((prev) => prev + 1);
          pushDiag(`repack runtime-bypass s${selectedServer}`);
          if (useFastFailover) {
            markCandidateAsBad(selectedServer, selectedHlsUrl, "repack-stale-manifest");
          }
          applyCandidatesPreservingSelection([]);
          selectedCandidateRef.current = 0;
          setSelectedCandidate(0);
          setResolverLoading(true);
          setPlayerError("تحديث R2 متوقف... جاري التحويل تلقائيًا للمصدر الاحتياطي.");
          scheduleResolveRecovery("repack-stale-manifest", true);
          hidePlayerLoading();
          try { instance.stopLoad(); } catch { }
        });
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (cancel || !data.fatal) return;
          const repackCandidate = isRepackPlaylistUrl(selectedHlsUrl);
          const responseCode = Number((data as { response?: { code?: number } })?.response?.code || 0);
          const errorDetails = String(data.details || "").toLowerCase();
          const repackManifestUnavailable =
            repackCandidate &&
            (responseCode === 404 ||
              responseCode === 403 ||
              errorDetails.includes("manifestloaderror") ||
              errorDetails.includes("manifestloadtimeout") ||
              errorDetails.includes("levelloaderror") ||
              errorDetails.includes("levelloadtimeout") ||
              errorDetails.includes("manifestparsingerror") ||
              errorDetails.includes("levelparsingerror"));
          if (repackManifestUnavailable) {
            if (!EMBED_FALLBACK_ENABLED) {
              pushDiag(`repack unavailable no-fallback code=${responseCode || 0} details=${errorDetails || "n/a"}`);
              const unavailableErrCount = (repackRecoveryErrorCountByServerRef.current[selectedServer] || 0) + 1;
              repackRecoveryErrorCountByServerRef.current[selectedServer] = unavailableErrCount;
              const failedSeedKey = String(lastRepackSeedCandidateKeyByServerRef.current[selectedServer] || "").trim();
              if (failedSeedKey) {
                const badSet = badRepackSeedCandidatesByServerRef.current[selectedServer] || new Set<string>();
                badSet.add(failedSeedKey);
                badRepackSeedCandidatesByServerRef.current[selectedServer] = badSet;
              }
              if (idNum) {
                const seedPrefix = `${idNum}:${selectedServer}:`;
                for (const key of Array.from(repackSeedSentRef.current.keys())) {
                  if (key.startsWith(seedPrefix)) repackSeedSentRef.current.delete(key);
                }
              }
              if (unavailableErrCount >= 3) {
                setPlayerError("تعذر تحميل R2 الآن... جاري إعادة المحاولة تلقائيًا.");
              } else if (unavailableErrCount >= 2) {
                setPlayerError("انقطاع مؤقت في R2... جاري التثبيت.");
              } else {
                setPlayerError(null);
              }
              queueTimeout(() => {
                requestSoftRecovery("repack-unavailable-no-fallback");
              }, 250);
              if (unavailableErrCount >= 2) {
                scheduleResolveRecovery("repack-unavailable-no-fallback", true);
              }
              hidePlayerLoading();
              return;
            }
            pushDiag(`repack unavailable code=${responseCode || 0} details=${errorDetails || "n/a"}`);
            if (!repackBypassServersRef.current.has(selectedServer)) {
              repackBypassServersRef.current.add(selectedServer);
              setRepackBypassVersion((prev) => prev + 1);
              pushDiag(`repack runtime-bypass s${selectedServer}`);
            }
            if (useFastFailover) {
              markCandidateAsBad(selectedServer, selectedHlsUrl, `repack-unavailable-${responseCode || 0}`);
            }
            applyCandidatesPreservingSelection([]);
            selectedCandidateRef.current = 0;
            setSelectedCandidate(0);
            setResolverLoading(true);
            setPlayerError("تعذر تشغيل R2... جاري التحويل تلقائيًا للمصدر الاحتياطي.");
            scheduleResolveRecovery("repack-runtime-bypass", true);
            hidePlayerLoading();
            return;
          }
          fatalRetries += 1;
          if (R2_STRICT_MODE) {
            const responseCode = Number((data as { response?: { code?: number } })?.response?.code || 0);
            const diagMessage = `fatal ${String(data.type || "unknown")} / ${String(data.details || "unknown")}${
              responseCode ? ` / http ${responseCode}` : ""
            }`;
            setStrictPlaybackDiag((prev) => (prev === diagMessage ? prev : diagMessage));
          }
          pushDiag(`fatal ${data.type} ${String(data.details)} retry=${fatalRetries}`);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && currentCandidateKey) {
            const now = Date.now();
            const prevState = networkFatalCountByCandidateRef.current.get(currentCandidateKey);
            const next =
              prevState && now - prevState.at <= NETWORK_FATAL_WINDOW_MS ? prevState.count + 1 : 1;
            networkFatalCountByCandidateRef.current.set(currentCandidateKey, { count: next, at: now });
            const strictSingleCandidate = R2_STRICT_MODE && candidatesRef.current.length <= 1;
            if (strictSingleCandidate) {
              const progressedRecently =
                !video.paused &&
                video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
                now - lastProgressAtRef.current <= 2500;
              if (progressedRecently) {
                pushDiag(`strict-single hold source network=${next}`);
                return;
              }
              setPlayerError("انقطاع مؤقت بالشبكة... جاري إعادة المزامنة");
              queueTimeout(() => {
                requestSoftRecovery("network-strict-single");
              }, Math.min(2800, 900 + next * 450));
              pushDiag(`strict-single recover network=${next}`);
              return;
            }
            const fastFailoverThreshold = selectedServer === 5 ? 3 : (R2_STRICT_MODE ? 4 : 2);
            if (useFastFailover && next >= fastFailoverThreshold) {
              if (selectedServer === 5) {
                const lastFastFailoverAt = lastFastFailoverAtByServerRef.current[5] || 0;
                if (now - lastFastFailoverAt < SERVER5_FAST_FAILOVER_COOLDOWN_MS) {
                  pushDiag("fast-failover server5 cooldown");
                  return;
                }
                lastFastFailoverAtByServerRef.current[5] = now;
              }
              pushDiag(`fast-failover server${selectedServer} network=${next}`);
              markCandidateAsBad(selectedServer, selectedHlsUrl, "network-fast-failover");
              moveNext("network-fast-failover");
              return;
            }
          }
          if (fatalRetries <= 6) {
            const delay = Math.min(3500, 500 + fatalRetries * 700);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              setPlayerError("انقطاع مؤقت بالشبكة... جاري المحاولة تلقائيًا");
              queueTimeout(() => {
                requestSoftRecovery();
              }, delay);
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              setPlayerError("خطأ وسائط... جاري الإصلاح تلقائيًا");
              queueTimeout(() => {
                try { instance.recoverMediaError(); } catch { }
                queueTimeout(() => {
                  requestSoftRecovery();
                }, 150);
              }, delay);
              return;
            }
          }
          if (useFastFailover) {
            markCandidateAsBad(selectedServer, selectedHlsUrl, `fatal-${String(data.type || "unknown")}`);
          }
          moveNext(`${data.type}`);
        });
        instance.attachMedia(video);
      };

      const initStandardHls = () => {
        if (cancel) return;
        const instance = new Hls(baseHlsConfig);
        attachHlsInstance(instance);
      };

      if (isP2PPlayback) {
        const swarmMatchId = idNum ?? "unknown";
        const swarmId = `match-${swarmMatchId}-server-${selectedServer}`;
        void import(/* webpackIgnore: true */ ESM_SH_PROCESS_SHIM_URL)
          .then((procMod) => {
            const shim = (procMod as { default?: { browser?: boolean } }).default;
            if (shim && typeof shim === "object") shim.browser = true;
          })
          .catch(() => { })
          .then(() => import(/* webpackIgnore: true */ P2P_HLSJS_BROWSER_MODULE_URL))
          .then((mod) => {
            if (cancel) return;
            const EngineCtor = (mod as { HlsJsP2PEngine?: P2PEngineConstructor }).HlsJsP2PEngine;
            if (typeof EngineCtor !== "function") throw new Error("P2P engine export is missing");
            p2pEngine = new EngineCtor({
              core: {
                swarmId,
              },
            });
            const mergedConfig = {
              ...baseHlsConfig,
              ...p2pEngine.getConfigForHlsJs(),
            };
            const instance = new Hls(mergedConfig);
            if (cancel) {
              try { p2pEngine.destroy(); } catch { }
              try { instance.destroy(); } catch { }
              return;
            }
            p2pEngine.bindHls(instance);
            pushDiag(`p2p enabled profile=${P2P_PROFILE} swarm=${swarmId}`);

            const onPeerConnect = () => {
              p2pStats.peerCount += 1;
              logP2PStats();
            };
            const onPeerClose = () => {
              p2pStats.peerCount = Math.max(0, p2pStats.peerCount - 1);
              logP2PStats();
            };
            const onChunkDownloaded = (...args: unknown[]) => {
              const bytesLength = Number(args[0] || 0);
              const downloadSource = String(args[1] || "").toLowerCase();
              if (!Number.isFinite(bytesLength) || bytesLength <= 0) return;
              if (downloadSource === "p2p") p2pStats.p2pBytes += bytesLength;
              else p2pStats.httpBytes += bytesLength;
              logP2PStats();
            };
            const onChunkUploaded = (...args: unknown[]) => {
              const bytesLength = Number(args[0] || 0);
              if (!Number.isFinite(bytesLength) || bytesLength <= 0) return;
              p2pStats.uploadedBytes += bytesLength;
              logP2PStats();
            };
            const onSegmentError = () => {
              pushDiag("p2p segment-error");
              logP2PStats(true);
            };
            p2pEngine.addEventListener("onPeerConnect", onPeerConnect);
            p2pEngine.addEventListener("onPeerClose", onPeerClose);
            p2pEngine.addEventListener("onChunkDownloaded", onChunkDownloaded);
            p2pEngine.addEventListener("onChunkUploaded", onChunkUploaded);
            p2pEngine.addEventListener("onSegmentError", onSegmentError);
            detachP2PListeners = () => {
              if (!p2pEngine) return;
              p2pEngine.removeEventListener("onPeerConnect", onPeerConnect);
              p2pEngine.removeEventListener("onPeerClose", onPeerClose);
              p2pEngine.removeEventListener("onChunkDownloaded", onChunkDownloaded);
              p2pEngine.removeEventListener("onChunkUploaded", onChunkUploaded);
              p2pEngine.removeEventListener("onSegmentError", onSegmentError);
            };
            attachHlsInstance(instance);
          })
          .catch((error: unknown) => {
            pushDiag(`p2p init failed: ${error instanceof Error ? error.message : String(error)}`);
            initStandardHls();
          });
      } else {
        initStandardHls();
      }
    } else {
      setPlayerError("متصفحك لا يدعم تشغيل HLS داخليًا.");
      hidePlayerLoading();
    }

    const stallFreezeMs = isP2PPlayback ? P2P_STALL_FREEZE_MS : STALL_FREEZE_MS;
    const minStallBeforeSwitchMs = isP2PPlayback ? stallFreezeMs * 2 : stallFreezeMs;
    stallTimerRef.current = window.setInterval(() => {
      if (cancel) return;
      if (video.paused || video.seeking) {
        lastProgressAtRef.current = Date.now();
        return;
      }
      const currentTime = Number(video.currentTime);
      if (Number.isFinite(currentTime) && currentTime > lastProgressRef.current + 0.05) {
        lastProgressRef.current = currentTime;
        lastProgressAtRef.current = Date.now();
        stallFreezeCount = 0;
        freezeTriggered = false;
        if (selectedServer === 5) hidePlayerLoading();
        return;
      }
      const stalledFor = Date.now() - lastProgressAtRef.current;
      const waitingState =
        video.readyState <= 2 ||
        video.networkState === HTMLMediaElement.NETWORK_LOADING ||
        video.networkState === HTMLMediaElement.NETWORK_IDLE;
      if (!waitingState || stalledFor < stallFreezeMs || freezeTriggered) return;
      freezeTriggered = true;
      stallFreezeCount += 1;
      if (isRepackPlaylistUrl(selectedHlsUrl)) {
        repackStallCountByServerRef.current[selectedServer] =
          (repackStallCountByServerRef.current[selectedServer] || 0) + 1;
      }
      const total = candidatesRef.current.length;
      pushDiag(`stall-freeze ${stalledFor}ms source=${current + 1}/${Math.max(1, total)}`);
      requestSoftRecovery("stall-watchdog");
      if (total <= 1) {
        const fallbackCandidate = String(selectedFallbackUrl || "").trim();
        const fallbackUnderlying = String(toUnderlyingUrl(fallbackCandidate) || fallbackCandidate).trim();
        const canSwitchToLegacyFallback =
          EMBED_FALLBACK_ENABLED &&
          stallFreezeCount >= 2 &&
          isRepackPlaylistUrl(selectedHlsUrl) &&
          !!fallbackCandidate &&
          !isRepackPlaylistUrl(fallbackUnderlying) &&
          isValidHttpUrl(fallbackUnderlying);
        if (canSwitchToLegacyFallback) {
          pushDiag("repack single-source stall -> runtime bypass");
          trackRepackFallback("stall-single-source", selectedHlsUrl, fallbackCandidate);
          if (!repackBypassServersRef.current.has(selectedServer)) {
            repackBypassServersRef.current.add(selectedServer);
            setRepackBypassVersion((prev) => prev + 1);
            pushDiag(`repack runtime-bypass s${selectedServer}`);
          }
          if (useFastFailover) {
            markCandidateAsBad(selectedServer, selectedHlsUrl, "repack-single-source-stall");
          }
          applyCandidatesPreservingSelection([]);
          selectedCandidateRef.current = 0;
          setSelectedCandidate(0);
          setResolverLoading(true);
          setPlayerError("تم التحويل تلقائيًا للمصدر الاحتياطي لضمان استمرارية البث.");
          scheduleResolveRecovery("repack-stall-runtime-bypass", true);
          hidePlayerLoading();
          freezeTriggered = false;
          stallFreezeCount = 0;
          return;
        }
        // Single-source playback: avoid hard source switch loops; keep trying in-place.
        setPlayerError("انقطاع مؤقت... جاري إعادة المزامنة");
        queueTimeout(() => {
          freezeTriggered = false;
          hidePlayerLoading();
          requestSoftRecovery("stall-single-source");
        }, 1800);
        return;
      }
      queueTimeout(() => {
        if (cancel) return;
        const progressed = Number(video.currentTime);
        if (Number.isFinite(progressed) && progressed > lastProgressRef.current + 0.2) {
          stallFreezeCount = 0;
          freezeTriggered = false;
          hidePlayerLoading();
          return;
        }
        const stillWaiting =
          video.readyState <= 2 ||
          video.networkState === HTMLMediaElement.NETWORK_LOADING ||
          video.networkState === HTMLMediaElement.NETWORK_IDLE;
        const stillStalled = Date.now() - lastProgressAtRef.current >= stallFreezeMs;
        if (!stillWaiting || !stillStalled) {
          stallFreezeCount = 0;
          freezeTriggered = false;
          hidePlayerLoading();
          return;
        }
        const stalledTotalMs = Date.now() - lastProgressAtRef.current;
        if (stalledTotalMs < minStallBeforeSwitchMs) {
          setPlayerError("انقطاع مؤقت... جاري إعادة المزامنة");
          freezeTriggered = false;
          hidePlayerLoading();
          requestSoftRecovery("stall-pre-switch-guard");
          return;
        }
        if (stallFreezeCount < 2) {
          setPlayerError("انقطاع مؤقت... جاري إعادة المزامنة");
          freezeTriggered = false;
          hidePlayerLoading();
          requestSoftRecovery("stall-retry");
          return;
        }
        stallFreezeCount = 0;
        freezeTriggered = false;
        moveNext("stall");
      }, 1200);
    }, 1500);

    return () => {
      cancel = true;
      for (const id of timeoutHandles) window.clearTimeout(id);
      clearServer5StartupNoFrameTimer();
      clearLoadingOverlayTimer();
      clearAutoAudioSyncTimer();
      clearStallWatchdog();
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("loadedmetadata", onCanPlay);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (isP2PPlayback) logP2PStats(true);
      try { detachP2PListeners?.(); } catch { }
      try { p2pEngine?.destroy(); } catch { }
      try { hls?.destroy(); } catch { }
      setHlsInstance(null);
      reset();
    };
  }, [
    idNum,
    selectedHlsUrl,
    selectedCandidate,
    selectedServer,
    selectedUrl,
    selectedFallbackUrl,
    shouldBlockStream,
    pushDiag,
    p2pEnabledServerSet,
    requestRepackSeed,
    reportRepackPlaybackDiag,
    applyCandidatesPreservingSelection,
    markCandidateAsBad,
    clearCandidateFailureMarks,
    setResolverError,
    scheduleResolveRecovery,
    resetRecoveryState,
  ]);

  const prettyStart = formatStartTimeAr(match?.match_start);
  const streamOpenLabel = formatTimeOnlyAr(streamOpenMs);
  const streamStartNotice = (() => {
    if (!LIVE_ONLY_PLAYBACK) {
      return streamOpenLabel
        ? `سيبدأ البث في الساعة ${streamOpenLabel} (قبل ساعة المباراة بنصف ساعة)`
        : "سيبدأ البث قبل ساعة المباراة بنصف ساعة";
    }
    if (!matchWindow.hasStart) return "البث غير متاح لأن موعد المباراة غير محدد.";
    if (matchWindow.openAtMs !== null && nowMs < matchWindow.openAtMs) {
      return streamOpenLabel
        ? `سيبدأ البث في الساعة ${streamOpenLabel} (قبل ساعة المباراة بنصف ساعة)`
        : "سيبدأ البث قبل ساعة المباراة بنصف ساعة";
    }
    if (matchWindow.closeAtMs !== null && nowMs > matchWindow.closeAtMs) {
      return "انتهت نافذة البث لهذه المباراة.";
    }
    return "البث غير متاح حاليًا.";
  })();
  const noStreamLabel = selectedUrl ? NO_STREAM_SELECTED_SERVER_MESSAGE : "لا يوجد بث";
  const home = match?.home_team ?? "الفريق الأول";
  const away = match?.away_team ?? "الفريق الثاني";

  if (loading) return <div className="text-white text-center mt-20">جاري تحميل البث...</div>;
  if (errMsg) return <div className="text-white text-center mt-20">{errMsg}</div>;

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-5xl mx-auto">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {isTfPlayerHost ? (
            <a
              href="https://twofooty.com/"
              target="_top"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-white"
            >
              Back Home
            </a>
          ) : (
            <Link href="/" className="text-gray-400 hover:text-white">Back Home</Link>
          )}
          {!isTfPlayerHost ? <Link href="/test" className="text-blue-400 hover:text-blue-300 font-bold text-sm">Test</Link> : null}
        </div>

        <div className="mb-4 rounded-2xl border border-gray-800 bg-gradient-to-r from-[#1b1b1b] via-[#111111] to-[#1b1b1b] p-5 shadow-2xl">
          <div className="flex flex-col items-center text-center gap-2">
            <div className="text-2xl sm:text-3xl font-black">لا يوجد اعلانات</div>
            <div className="text-sm sm:text-base text-gray-300">كبر الفيديو وعييييش</div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {visibleServerOptions.map((s) => {
            const hasUrl = !!s.url && isValidHttpUrl(s.url);
            const health: ServerHealthState = serverHealth[s.n] ?? (hasUrl ? "ok" : "down");
            const ok = hasUrl;
            const selected = selectedServer === s.n;
            const strictEntry = R2_STRICT_MODE ? strictR2StatusBySlot.get(s.n) : undefined;
            const canSelect = R2_STRICT_MODE ? strictEntry?.state === "ready" : ok;
            const slotHasSource = !!strictSourcePresentBySlot[s.n];
            const bootstrapPending = !!strictBootstrapPendingBySlot[s.n];
            const bootstrapAttempted = !!strictBootstrapAttemptedBySlot[s.n];
            const subtitle = R2_STRICT_MODE
              ? getStrictServerSubtitle(strictEntry, health, ok, slotHasSource, bootstrapPending, bootstrapAttempted)
              : health === "pending"
                ? "جاري التحضير"
                : (!ok || health === "down" ? "لا يوجد بث" : null);
            return (
              <button
                key={s.n}
                onClick={() => canSelect && setSelectedServer(s.n)}
                disabled={!canSelect}
                className={[
                  "px-4 py-2 rounded-xl font-black text-sm border transition-all min-w-[108px] text-center",
                  selected
                    ? "bg-blue-600/20 text-blue-300 border-blue-600/50"
                    : canSelect
                      ? "bg-[#121212] text-gray-200 border-gray-800 hover:border-blue-600/40"
                      : "bg-[#0f0f0f] text-gray-500 border-gray-900 cursor-not-allowed",
                ].join(" ")}
              >
                <div>{s.label}</div>
                {subtitle ? <div className="mt-0.5 text-[10px] font-semibold text-gray-400">{subtitle}</div> : null}
              </button>
            );
          })}
          {R2_STRICT_MODE && diagQueryEnabled ? (
            <button
              type="button"
              onClick={() => setDiagVisible((prev) => !prev)}
              className={[
                "px-3 py-2 rounded-xl font-black text-xs border transition-all",
                effectiveDiagEnabled
                  ? "bg-amber-900/30 text-amber-200 border-amber-700/50"
                  : "bg-[#121212] text-gray-300 border-gray-800 hover:border-amber-700/50",
              ].join(" ")}
            >
              {effectiveDiagEnabled ? "إخفاء التشخيص" : "إظهار التشخيص"}
            </button>
          ) : null}
        </div>

        {R2_STRICT_MODE && effectiveDiagEnabled && strictPlaybackDiag ? (
          <div className="mb-3 rounded-xl border border-yellow-800/40 bg-yellow-500/10 px-3 py-2 text-[11px] font-semibold text-yellow-200">
            تشخيص R2: {strictPlaybackDiag}
          </div>
        ) : null}

        {candidateGroups.length > 0 ? (
          <div className="mb-3 rounded-2xl border border-blue-800/30 bg-[#0f1520] p-4">
            <div className="text-xl sm:text-2xl font-black text-blue-300 mb-3">مصادر {selectedServerLabel}</div>
            <div className="flex flex-wrap gap-2">
              {candidateGroups.map((group, idx) => (
                <button
                  key={`${group.key}-${idx}`}
                  onClick={() => setSelectedCandidate(group.primaryIndex)}
                  className={[
                    "rounded-lg border px-4 py-2 text-sm font-bold transition-colors min-w-[96px]",
                    idx === activeCandidateGroupIndex
                      ? "border-blue-500 bg-blue-900/20 text-blue-100"
                      : "border-gray-700 bg-[#0b0f15] text-gray-100 hover:border-blue-600/50",
                  ].join(" ")}
                >
                  <div>{group.label ? `جودة ${group.label}` : `مصدر ${idx + 1}`}</div>
                  {group.members.length > 1 ? (
                    <div className="mt-0.5 text-[10px] font-semibold text-blue-200/80">جودات متعددة</div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div ref={playerHostRef} className="bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-gray-800">
          {shouldBlockStream ? (
            <div className="flex flex-col gap-2 items-center justify-center h-[55vh] min-h-[320px] text-gray-400 p-6 text-center">
              <div className="text-white font-bold text-xl">{streamStartNotice}</div>
              {prettyStart ? <div className="text-sm text-gray-500">موعد المباراة: <span className="text-gray-300">{prettyStart}</span></div> : null}
            </div>
          ) : selectedHlsUrl ? (
            <div onDoubleClick={handleVideoDoubleClick} className="relative w-full aspect-video min-h-[280px] sm:min-h-[430px] bg-black overflow-hidden">
              <video
                ref={videoRef}
                playsInline
                autoPlay
                preload="auto"
                onDoubleClick={handleVideoDoubleClick}
                className="w-full h-full bg-black"
              />
              <VideoPlayerControls
                videoRef={videoRef}
                hls={hlsInstance}
                title={`${home} ${match?.match_start ? "" : ""} vs ${away}`}
                isLive={true}
              />
              {playerLoading ? <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-gray-200">جاري تشغيل البث</div> : null}
            </div>
          ) : resolverLoading ? (
            <div className="flex items-center justify-center h-[55vh] min-h-[320px] text-gray-300">جاري تشغيل البث</div>
          ) : (
            <div className="flex items-center justify-center h-[55vh] min-h-[320px] text-gray-400 p-6 text-center">{noStreamLabel}</div>
          )}
        </div>

        {resolverError ? <div className="mt-2 text-xs text-red-200 bg-red-900/20 border border-red-700/40 rounded-lg px-3 py-2">{resolverError}</div> : null}
        {playerError &&
        (!R2_STRICT_MODE || effectiveDiagEnabled || Date.now() - lastProgressAtRef.current > 3500) ? (
          <div className="mt-2 text-xs text-amber-200 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">{playerError}</div>
        ) : null}
        {R2_STRICT_MODE && strictRecoveryState === "breaker_open" ? (
          <div className="mt-2 text-xs text-blue-100 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-3 flex items-center justify-between gap-3">
            <div>
              <div className="font-bold">R2 Circuit Breaker مفتوح مؤقتًا.</div>
              <div className="text-blue-200/90">
                {strictBreakerRemainingSec > 0 ? `إعادة المحاولة التلقائية بعد ${strictBreakerRemainingSec} ثانية.` : "يمكنك إعادة المحاولة الآن."}
              </div>
            </div>
            <button
              onClick={handleStrictRetryNow}
              className="rounded-md border border-blue-500/70 bg-blue-900/40 hover:bg-blue-800/50 px-3 py-1.5 font-bold text-blue-50"
            >
              إعادة المحاولة الآن
            </button>
          </div>
        ) : null}

        {effectiveDiagEnabled ? (
          <div className="mt-3 rounded-xl border border-amber-700/40 bg-[#16130a] p-3">
            <div className="max-h-48 overflow-auto text-[11px] text-amber-100/90 whitespace-pre-wrap leading-5">
              {diagLogs.length ? diagLogs.join("\n") : "No diag events yet."}
            </div>
          </div>
        ) : null}

        <div className="mt-6 bg-[#161616] p-6 rounded-2xl border border-gray-800 flex justify-between items-center">
          <div className="text-center flex-1 font-bold text-xl">{home}</div>
          <div className="text-red-500 font-black px-4">VS</div>
          <div className="text-center flex-1 font-bold text-xl">{away}</div>
        </div>
      </div>
    </div>
  );
}
