"use client";

import Hls from "hls.js";
import Link from "next/link";
import VideoPlayerControls from "@/components/VideoPlayerControls";
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
};

type ServerOption = { n: number; label: string; url: string | null };
type ServerHealthState = "ok" | "down";

const SERVER_SOURCE_LABELS: Record<number, string> = {
  1: "سيرفر 1 ",
  2: "سيرفر 2 ",
  3: "سيرفر 3 ",
  4: "سيرفر 4 ",
};

const PREMATCH_OPEN_WINDOW_MINUTES = 30;
const STALL_FREEZE_MS = 12000;
const PLAYER_LOADING_OVERLAY_DELAY_MS = 600;
const DEFAULT_PLAYER_QUALITY_HEIGHT = 480;
const AUTO_RECOVERY_SCHEDULE_MS = [5000, 10000, 20000, 30000] as const;
const RESOLVE_COOLDOWN_MS = 1500;
const CANDIDATE_PROBE_TIMEOUT_MS = 6500;
const FAST_PHASE_PROBE_TIMEOUT_MS = 2200;
const FAST_PHASE_MAX_PLAYER_PAGES = 2;
const FAST_PHASE_MAX_DEEP_CANDIDATES = 4;
const FAST_PHASE_MAX_PLAYERV2_POOL = 2;
const RESOLVE_CHILD_CONCURRENCY = 3;
const EXPAND_VARIANTS_CONCURRENCY = 4;
const PROBE_CONCURRENCY = 4;
const RESOLVE_RESULT_CACHE_TTL_MS = 75_000;
const RESOLVE_RESULT_CACHE_MAX = 250;
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
type ResolveResultCacheEntry = { expiresAt: number; candidates: string[] };
type CandidateGroup = { key: string; primaryIndex: number; members: number[]; label: string };

const resolveResultCache = new Map<string, ResolveResultCacheEntry>();

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
  const cleaned = dedupeUrls((candidates || []).filter((x) => !!x));
  if (!cleaned.length) return;
  const now = Date.now();
  resolveResultCache.set(resolveResultCacheKey(sourceUrl), {
    expiresAt: now + RESOLVE_RESULT_CACHE_TTL_MS,
    candidates: cleaned,
  });
  trimResolveResultCache(now);
}

function clearCachedResolveCandidates(sourceUrl: string) {
  resolveResultCache.delete(resolveResultCacheKey(sourceUrl));
}

function isValidHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isClearlyNonStreamUrl(value?: string | null) {
  const v = String(value || "").trim();
  if (!v || !isValidHttpUrl(v)) return true;
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

function toUnderlyingUrl(value: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!v.startsWith("/api/embed-proxy?")) return v;
  return getProxyTargetUrl(v) || v;
}

function isPlayerv2LikeUrl(value?: string | null) {
  const raw = toUnderlyingUrl(String(value || ""));
  return /\/playerv2\.php(?:\?|$)/i.test(raw) || /[?&]action=generate_token(?:&|$)/i.test(raw);
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
  const value = String(rawUrl || "").trim();
  if (!value) return "";
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

function toPlayableProxyFromManifestLine(rawLine: string, parentCandidateUrl: string) {
  const line = String(rawLine || "").trim();
  if (!line) return null;
  if (line.startsWith("/api/embed-proxy?")) return line;

  const parentTarget = parentCandidateUrl.startsWith("/api/embed-proxy?")
    ? getProxyTargetUrl(parentCandidateUrl)
    : isValidHttpUrl(parentCandidateUrl)
      ? parentCandidateUrl
      : null;

  if (isValidHttpUrl(line)) {
    return toEmbedProxyUrl(line, parentTarget || line);
  }

  if (!parentTarget || !isValidHttpUrl(parentTarget)) return null;
  try {
    const absolute = new URL(line, parentTarget).toString();
    return toEmbedProxyUrl(absolute, parentTarget);
  } catch {
    return null;
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
    return Number.isFinite(n) && n > 0 ? n : null;
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

    const order = currentServRaw === "0" ? ["0", "1"] : ["1", "0"];
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

function materializeTemplateUrl(raw: string, sourceUrl: string) {
  let value = String(raw || "").trim();
  if (!value.includes("${")) return value;

  let matchId = "";
  try {
    matchId = String(new URL(sourceUrl).searchParams.get("match") || "").trim();
  } catch { }
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

function extractPlayerPageCandidatesFromProxyHtml(html: string, sourceUrl: string) {
  const text = String(html || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const out: string[] = [];
  const seen = new Set<string>();
  const isPlayerLike = (url: string) =>
    PLAYER_PAGE_HINT_RE.test(url) ||
    isLikelyChannelLandingPlayerPageUrl(url) ||
    isKnownRelayPlayerPageUrl(url) ||
    isKnownEmbeddedLivePhpPlayerUrl(url);
  const add = (raw: string) => {
    let v = String(raw || "").trim().replace(/[),;]+$/g, "");
    if (v.includes("${")) {
      const materialized = materializeTemplateUrl(v, sourceUrl);
      if (materialized) v = materialized;
    }
    if (!v) return;

    if (v.startsWith("/api/embed-proxy?")) {
      const target = getProxyTargetUrl(v);
      if (!target || !isValidHttpUrl(target)) return;
      const expandedTargets = dedupeUrls([target, ...expandLivehdTvServVariants(target)]);
      for (const candidate of expandedTargets) {
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

  return Array.from(map.values()).sort((a, b) => {
    const aq = qualityRank(a.label);
    const bq = qualityRank(b.label);
    if (aq !== bq) return bq - aq;
    return a.primaryIndex - b.primaryIndex;
  });
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

  if (!domains.size) {
    try {
      domains.add(`${new URL(pageUrl).origin}/`);
    } catch { }
  }

  if (!domains.size) {
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
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rnd = () => {
    let out = "";
    for (let i = 0; i < 4; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  };
  const slot = Math.floor(Date.now() / 1920);
  return [
    `${rnd()}${(slot - 3064).toString(36)}`,
    `${rnd()}${(slot + 3064).toString(36)}`,
    `${rnd()}${Math.floor(Date.now() / 1000).toString(36)}`,
  ];
}

async function requestPlayerv2TokenFromProxy(
  playerv2Url: string,
  tokenPath: string,
  signal?: AbortSignal,
  pushDiag?: (line: string) => void
) {
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

  const payloads = [
    new URLSearchParams({ path: tokenPath, fp: `${Math.random().toString(36).slice(2)}${Date.now()}` }).toString(),
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
      if (token && sid) return { token, session_id: sid } satisfies Playerv2TokenPayload;

      if (pushDiag && typeof data?.error === "string") {
        pushDiag(`playerv2 token error: ${String(data.error)}`);
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") break;
    }
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
    const pathVariants = Array.from(
      new Set([basePath, `${basePath}.m3u8`, `${basePath}/index.m3u8`, `${basePath}/mainIndex.m3u8`])
    );

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
    onBatchCandidates?: (batch: string[], phase: ResolveBatchPhase) => void;
    parallelChildConcurrency?: number;
    fetchTimeoutMs?: number;
    allowSamePathServVariants?: boolean;
  }
) {
  const maxPlayerPages = opts?.maxPlayerPages ?? 6;
  const maxDeepCandidates = opts?.maxDeepCandidates ?? 8;
  const maxPlayerv2Pool = opts?.maxPlayerv2Pool ?? 6;
  const parallelChildConcurrency = opts?.parallelChildConcurrency ?? RESOLVE_CHILD_CONCURRENCY;
  const fetchTimeoutMs = opts?.fetchTimeoutMs ?? CANDIDATE_PROBE_TIMEOUT_MS;
  const allowSamePathServVariants = opts?.allowSamePathServVariants ?? false;
  const sourceServ = getServFromUrl(sourceUrl);
  const sourcePathKey = normalizePathKey(sourceUrl);
  const normalizePlayableBatch = (input: string[]) =>
    dedupeUrls(input).filter((url) => {
      const target = url.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(url) || "" : url;
      return isStrongPlayableStreamUrl(target) || isLikelyLivePhpEndpointUrl(target);
    });
  const emitBatch = (batch: string[], phase: ResolveBatchPhase) => {
    const normalized = normalizePlayableBatch(batch);
    if (normalized.length) opts?.onBatchCandidates?.(normalized, phase);
  };

  const fetchHtml = async (url: string) => {
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
  };

  if (isStrongPlayableStreamUrl(sourceUrl) || isLikelyLivePhpEndpointUrl(sourceUrl)) {
    const one = toEmbedProxyUrl(sourceUrl, sourceUrl);
    if (one) emitBatch([one], "fast");
    return one ? [one] : [];
  }

  const probe = toEmbedProxyUrl(sourceUrl, sourceUrl);
  if (!probe) return [];

  const first = await fetchHtml(probe);
  if (HLS_CT.some((x) => first.ct.includes(x))) {
    return [probe];
  }

  if (!first.ct.includes("text/html") && !first.ct.includes("application/xhtml+xml")) {
    return [];
  }

  const html = await first.res.text();
  const primaryList = extractPlayableCandidatesFromProxyHtml(html, sourceUrl);
  const rollingPrimary = extractRollingHlsCandidatesFromHtml(html, sourceUrl);
  emitBatch([...rollingPrimary, ...primaryList], "fast");
  const isSameServerVariantPage = (value: string) => {
    const target = value.startsWith("/api/embed-proxy?") ? getProxyTargetUrl(value) || "" : value;
    if (!target || !isValidHttpUrl(target)) return false;

    const targetServ = getServFromUrl(target);
    if (sourceServ !== null) {
      if (targetServ !== null && targetServ !== sourceServ) return false;
      return true;
    }

    if (!allowSamePathServVariants && targetServ !== null && normalizePathKey(target) === sourcePathKey) {
      return false;
    }
    return true;
  };
  const playerPages = extractPlayerPageCandidatesFromProxyHtml(html, sourceUrl);
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
      const childList = extractPlayableCandidatesFromProxyHtml(childHtml, extractionBaseUrl);
      const childRolling = extractRollingHlsCandidatesFromHtml(childHtml, extractionBaseUrl);
      const nextPlayerPages = extractPlayerPageCandidatesFromProxyHtml(childHtml, extractionBaseUrl);
      return {
        deep: childList,
        rolling: childRolling,
        playerv2: pageBaseUrl && isValidHttpUrl(pageBaseUrl) ? { pageUrl: pageBaseUrl, html: childHtml } : null,
        playable: [...childRolling, ...childList],
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
  const playerv2Results = await mapWithConcurrency(
    playerv2HtmlPool.slice(0, maxPlayerv2Pool),
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

  return normalizePlayableBatch([...rollingPrimary, ...primaryList, ...rollingDeepList, ...deepList, ...playerv2List]);
}

async function probeHlsCandidate(candidateUrl: string, opts?: ProbeHlsOptions) {
  const timeoutMs = opts?.timeoutMs ?? CANDIDATE_PROBE_TIMEOUT_MS;
  const maxChildChecks = opts?.maxChildChecks ?? 3;
  const pushDiag = opts?.pushDiag;
  const signal = opts?.signal;

  try {
    const manifestRes = await fetchWithTimeout(
      candidateUrl,
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-embed-proxy-probe": "1" },
      },
      timeoutMs,
      signal
    );

    if (!manifestRes.ok) {
      pushDiag?.(`probe manifest failed status=${manifestRes.status}`);
      return false;
    }

    const contentType = (manifestRes.headers.get("content-type") || "").toLowerCase();
    const manifestText = await manifestRes.text();
    const hasExtM3u = /^\s*#EXTM3U/m.test(manifestText);
    if (!contentTypeLooksLikeHls(contentType) && !hasExtM3u) {
      pushDiag?.(`probe not-hls ct=${contentType}`);
      return false;
    }

    const childLines = extractManifestMediaUris(manifestText, maxChildChecks);
    if (!childLines.length) return true;

    for (const childLine of childLines) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const childProxy = toPlayableProxyFromManifestLine(childLine, candidateUrl);
      if (!childProxy) continue;

      try {
        const headRes = await fetchWithTimeout(
          childProxy,
          {
            method: "HEAD",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1" },
          },
          timeoutMs,
          signal
        );
        if (headRes.ok) return true;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }

      try {
        const getRes = await fetchWithTimeout(
          childProxy,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-embed-proxy-probe": "1", range: "bytes=0-1024" },
          },
          timeoutMs,
          signal
        );
        if (getRes.ok) return true;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
      }
    }

    pushDiag?.("probe no reachable child line");
    return false;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    pushDiag?.(`probe error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
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
  const [derivedServerVariants, setDerivedServerVariants] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [hlsInstance, setHlsInstance] = useState<Hls | null>(null);

  const [selectedServer, setSelectedServer] = useState(1);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resolverLoading, setResolverLoading] = useState(false);
  const [resolverError, setResolverError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [resolveRevision, setResolveRevision] = useState(0);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [serverHealth, setServerHealth] = useState<Record<number, ServerHealthState>>({});
  const [diagLogs, setDiagLogs] = useState<string[]>([]);
  const candidatesRef = useRef<string[]>([]);
  const selectedCandidateRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryAttemptRef = useRef(0);
  const lastResolveKickRef = useRef(0);
  const resolveLockRef = useRef(false);
  const activeResolveIdRef = useRef(0);
  const lastProgressRef = useRef(0);
  const lastProgressAtRef = useRef(Date.now());
  const stallTimerRef = useRef<number | null>(null);

  const diagEnabled = searchParams.get("diag") === "1";
  const pushDiag = useCallback((line: string) => {
    if (!diagEnabled) return;
    setDiagLogs((prev) => [line, ...prev].slice(0, 120));
  }, [diagEnabled]);

  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  useEffect(() => {
    selectedCandidateRef.current = selectedCandidate;
  }, [selectedCandidate]);

  const applyCandidatesPreservingSelection = useCallback((nextCandidates: string[]) => {
    const next = dedupeUrls(nextCandidates);
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

    candidatesRef.current = next;
    if (nextIdx !== prevIdx) {
      selectedCandidateRef.current = nextIdx;
      setSelectedCandidate(nextIdx);
    }
    setCandidates(next);
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const resetRecoveryState = useCallback(() => {
    recoveryAttemptRef.current = 0;
    clearRecoveryTimer();
  }, [clearRecoveryTimer]);

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
      if (immediate && bumpResolveRevision(`${reason}:immediate`)) return;

      const idx = Math.min(recoveryAttemptRef.current, AUTO_RECOVERY_SCHEDULE_MS.length - 1);
      const delay = AUTO_RECOVERY_SCHEDULE_MS[idx];
      recoveryAttemptRef.current += 1;
      pushDiag(`resolve recovery (${reason}) in ${delay}ms`);
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (bumpResolveRevision(`${reason}:timer`)) return;
        recoveryTimerRef.current = window.setTimeout(() => {
          recoveryTimerRef.current = null;
          bumpResolveRevision(`${reason}:timer-retry`);
        }, RESOLVE_COOLDOWN_MS);
      }, delay);
    },
    [bumpResolveRevision, clearRecoveryTimer, pushDiag]
  );

  useEffect(() => {
    return () => {
      clearRecoveryTimer();
      if (stallTimerRef.current !== null) {
        clearInterval(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
  }, [clearRecoveryTimer]);

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

  const serverOptions = useMemo<ServerOption[]>(() => {
    // Strict isolation: each server only uses its own dedicated URL
    const explicit: Array<string | null> = [
      match?.stream_url ?? null,
      match?.stream_url_2 ?? null,
      match?.stream_url_3 ?? null,
      match?.stream_url_4 ?? null,
      match?.stream_url_5 ?? null,
      match?.stream_url_6 ?? null,
    ];

    const out: ServerOption[] = [];
    for (let i = 0; i < 6; i += 1) {
      const n = i + 1;
      const raw = String(explicit[i] || "").trim();
      const url = raw && isValidHttpUrl(raw) ? raw : null;
      const label = SERVER_SOURCE_LABELS[n] || `سيرفر ${n}`;
      out.push({ n, label, url });
    }
    return out;
  }, [match]);

  const validServers = useMemo(() => serverOptions.filter((s) => s.url && isValidHttpUrl(s.url)), [serverOptions]);
  useEffect(() => {
    if (!validServers.some((s) => s.n === selectedServer) && validServers.length) setSelectedServer(validServers[0].n);
  }, [validServers, selectedServer]);

  useEffect(() => {
    setServerHealth(() => {
      const next: Record<number, ServerHealthState> = {};
      for (const s of serverOptions) {
        next[s.n] = s.url && isValidHttpUrl(s.url) ? "ok" : "down";
      }
      return next;
    });
  }, [serverOptions]);

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

  const selectedOption = validServers.find((s) => s.n === selectedServer);
  const selectedServerLabel = selectedOption?.label || SERVER_SOURCE_LABELS[selectedServer] || `سيرفر ${selectedServer}`;
  const selectedUrl = selectedOption?.url ?? "";
  const status = (match?.status_key ?? "").toLowerCase();
  const startMs = match?.match_start ? new Date(match.match_start).getTime() : null;
  const prematchMs = PREMATCH_OPEN_WINDOW_MINUTES * 60 * 1000;
  const streamOpenMs = startMs !== null && Number.isFinite(startMs) ? startMs - prematchMs : null;
  const hasStartedByTime = startMs !== null && Number.isFinite(startMs) ? nowMs >= startMs - prematchMs : false;
  const shouldBlockStream = !(status === "live" || status === "finished") && !hasStartedByTime && status === "upcoming";

  useEffect(() => {
    selectedCandidateRef.current = 0;
    setSelectedCandidate(0);
    setPlayerError(null);
    resetRecoveryState();
  }, [selectedServer, resetRecoveryState]);
  useEffect(() => {
    if (selectedCandidate >= candidates.length) {
      selectedCandidateRef.current = 0;
      setSelectedCandidate(0);
    }
  }, [candidates.length, selectedCandidate]);

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
      const seedCandidates = (() => {
        if (!isStrongPlayableStreamUrl(selectedUrl) && !isLikelyLivePhpEndpointUrl(selectedUrl)) return [] as string[];
        const proxied = toEmbedProxyUrl(selectedUrl, selectedUrl);
        return proxied ? [proxied] : [];
      })();
      const disableResolveCache = selectedServer === 3 || isPlayerv2LikeUrl(selectedUrl);
      const cachedCandidates = disableResolveCache ? [] : getCachedResolveCandidates(selectedUrl);
      const initialCandidates = dedupeUrls([...cachedCandidates, ...seedCandidates]);
      let hadPlayable = initialCandidates.length > 0;
      const mergeCandidates = (incoming: string[]) => {
        if (!incoming.length) return;
        hadPlayable = true;
        const merged = dedupeUrls([...candidatesRef.current, ...incoming]);
        applyCandidatesPreservingSelection(merged);
        if (!disableResolveCache) setCachedResolveCandidates(selectedUrl, merged);
      };

      setResolverError(null);
      applyCandidatesPreservingSelection(initialCandidates);
      setResolverLoading(!initialCandidates.length);
      if (cachedCandidates.length) pushDiag(`resolve cache hit +${cachedCandidates.length}`);
      if (seedCandidates.length) pushDiag(`resolve seed +${seedCandidates.length}`);
      try {
        const fastList = await resolveCandidatesForServer(selectedUrl, controller.signal, {
          playerv2Diag: pushDiag,
          parallelChildConcurrency: RESOLVE_CHILD_CONCURRENCY,
          allowSamePathServVariants: selectedServer === 3,
          maxPlayerPages: FAST_PHASE_MAX_PLAYER_PAGES,
          maxDeepCandidates: FAST_PHASE_MAX_DEEP_CANDIDATES,
          maxPlayerv2Pool: FAST_PHASE_MAX_PLAYERV2_POOL,
          fetchTimeoutMs: FAST_PHASE_PROBE_TIMEOUT_MS,
          onBatchCandidates: (batch, phase) => {
            if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
            mergeCandidates(batch);
            pushDiag(`resolve batch ${phase} +${batch.length} (fast)`);
          },
        });
        if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
        const fastMerged = dedupeUrls([...initialCandidates, ...fastList]);
        if (fastMerged.length) {
          hadPlayable = true;
          applyCandidatesPreservingSelection(fastMerged);
          if (!disableResolveCache) setCachedResolveCandidates(selectedUrl, fastMerged);
          setPlayerError(null);
          resetRecoveryState();
          setResolverLoading(false);
        } else {
          setResolverLoading(true);
        }

        const finalList = await resolveCandidatesForServer(selectedUrl, controller.signal, {
          playerv2Diag: pushDiag,
          parallelChildConcurrency: RESOLVE_CHILD_CONCURRENCY,
          allowSamePathServVariants: selectedServer === 3,
          onBatchCandidates: (batch, phase) => {
            if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
            mergeCandidates(batch);
            pushDiag(`resolve batch ${phase} +${batch.length}`);
          },
        });
        if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
        const playableList = await expandCandidatesWithManifestVariants(finalList, {
          signal: controller.signal,
          timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS,
          maxParents: 8,
          maxVariantsPerParent: 12,
          concurrency: EXPAND_VARIANTS_CONCURRENCY,
          pushDiag,
        });
        if (cancel || controller.signal.aborted || activeResolveIdRef.current !== resolveId) return;
        if (!cancel) {
          const mergedRaw = dedupeUrls([...candidatesRef.current, ...fastMerged, ...finalList, ...playableList]);
          const verified = await filterPlayableCandidates(mergedRaw, {
            signal: controller.signal,
            timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS,
            maxChecks: Math.min(36, mergedRaw.length),
            concurrency: Math.min(3, PROBE_CONCURRENCY),
            pushDiag,
          });
          const merged = verified.length ? verified : (selectedServer === 3 ? mergedRaw : []);
          if (mergedRaw.length) pushDiag(`probe ok ${merged.length}/${mergedRaw.length}`);
          applyCandidatesPreservingSelection(merged);
          if (merged.length && !disableResolveCache) setCachedResolveCandidates(selectedUrl, merged);
          if (!merged.length) {
            clearCachedResolveCandidates(selectedUrl);
            setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
            if (selectedServer !== 3) scheduleResolveRecovery("resolver-empty");
            else resetRecoveryState();
          } else {
            hadPlayable = true;
            setPlayerError(null);
            resetRecoveryState();
          }
        }
      } catch (e: unknown) {
        if (!cancel && !(e instanceof Error && e.name === "AbortError")) {
          if (!hadPlayable) {
            setResolverError(e instanceof Error ? e.message : "فشل استخراج المصادر.");
            if (selectedServer !== 3) scheduleResolveRecovery("resolver-error");
            else resetRecoveryState();
          } else {
            pushDiag(`resolve background error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        if (!cancel && activeResolveIdRef.current === resolveId) {
          setResolverLoading(false);
          resolveLockRef.current = false;
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
  ]);

  const selectedHlsUrl = candidates[selectedCandidate] || "";
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
    const current = selectedCandidate;
    let freezeTriggered = false;
    let loadingOverlayTimer: number | null = null;
    const timeoutHandles: number[] = [];
    const queueTimeout = (fn: () => void, delayMs: number) => {
      const id = window.setTimeout(() => {
        if (cancel) return;
        fn();
      }, delayMs);
      timeoutHandles.push(id);
      return id;
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
    const playWithAutoplayFallback = () => {
      video.play().catch(() => {
        if (cancel) return;
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute("muted", "");
        video.play().catch(() => { });
      });
    };
    const moveNext = (reason: string) => {
      const total = candidatesRef.current.length;
      if (current + 1 < total) {
        const nextIndex = current + 1;
        selectedCandidateRef.current = nextIndex;
        setSelectedCandidate(nextIndex);
        setPlayerError(`تعثر المصدر الحالي (${reason})، جاري التحويل تلقائيًا للمصدر التالي.`);
      } else {
        setPlayerError("فشل تشغيل كل مصادر HLS الداخلية.");
        if (selectedServer === 3) {
          applyCandidatesPreservingSelection([]);
          setResolverError(NO_STREAM_SELECTED_SERVER_MESSAGE);
          resetRecoveryState();
        } else {
          scheduleResolveRecovery(`player-exhausted:${reason}`, true);
        }
      }
      hidePlayerLoading();
    };
    const reset = () => {
      try { video.pause(); } catch { }
      video.removeAttribute("src");
      video.load();
    };
    clearStallWatchdog();
    reset();
    hidePlayerLoading();
    setPlayerError(null);
    if (shouldBlockStream || !selectedHlsUrl) return;
    setPlayerLoading(true);
    video.volume = 1;
    video.muted = false;
    video.defaultMuted = false;
    video.removeAttribute("muted");
    markProgress();
    let fatalRetries = 0;
    const onLoaded = () => {
      if (cancel) return;
      markProgress();
      hidePlayerLoading();
    };
    const onWaiting = () => {
      if (cancel) return;
      showPlayerLoadingDelayed();
      try {
        hls?.startLoad();
      } catch { }
      queueTimeout(() => {
        try {
          video.play().catch(() => { });
        } catch { }
      }, 150);
    };
    const onPlaying = () => {
      if (cancel) return;
      freezeTriggered = false;
      markProgress();
      resetRecoveryState();
      hidePlayerLoading();
      setPlayerError(null);
    };
    const onTimeUpdate = () => {
      markProgress();
      if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) hidePlayerLoading();
    };
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    if (shouldUseNativeHls(video)) {
      video.src = selectedHlsUrl;
      video.load();
      playWithAutoplayFallback();
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        backBufferLength: 90,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 15,
        startFragPrefetch: true,
        maxBufferHole: 1.2,
        highBufferWatchdogPeriod: 2,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 8,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.7,
      });
      setHlsInstance(hls);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(selectedHlsUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancel) return;
        const defaultLevel = pickDefaultHlsLevel(hls?.levels || []);
        if (defaultLevel >= 0 && hls) {
          // Hls.js quality switch API is implemented via mutable property assignment.
          hls.currentLevel = defaultLevel;
        }
        markProgress();
        resetRecoveryState();
        hidePlayerLoading();
        setPlayerError(null);
        playWithAutoplayFallback();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (cancel || !data.fatal) return;
        fatalRetries += 1;
        pushDiag(`fatal ${data.type} ${String(data.details)} retry=${fatalRetries}`);
        if (fatalRetries <= 6) {
          const delay = Math.min(3500, 500 + fatalRetries * 700);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setPlayerError("انقطاع مؤقت بالشبكة... جاري المحاولة تلقائيًا");
            queueTimeout(() => hls?.startLoad(), delay);
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setPlayerError("خطأ وسائط... جاري الإصلاح تلقائيًا");
            queueTimeout(() => hls?.recoverMediaError(), delay);
            return;
          }
        }
        moveNext(`${data.type}`);
      });
      hls.attachMedia(video);
    } else {
      setPlayerError("متصفحك لا يدعم تشغيل HLS داخليًا.");
      hidePlayerLoading();
    }

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
        return;
      }
      const stalledFor = Date.now() - lastProgressAtRef.current;
      const waitingState =
        video.readyState <= 2 ||
        video.networkState === HTMLMediaElement.NETWORK_LOADING ||
        video.networkState === HTMLMediaElement.NETWORK_IDLE;
      if (!waitingState || stalledFor < STALL_FREEZE_MS || freezeTriggered) return;
      freezeTriggered = true;
      const total = candidatesRef.current.length;
      pushDiag(`stall-freeze ${stalledFor}ms source=${current + 1}/${Math.max(1, total)}`);
      try {
        hls?.startLoad();
      } catch { }
      try {
        video.play().catch(() => { });
      } catch { }
      queueTimeout(() => moveNext("stall"), 250);
    }, 1500);

    return () => {
      cancel = true;
      for (const id of timeoutHandles) window.clearTimeout(id);
      clearLoadingOverlayTimer();
      clearStallWatchdog();
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdate);
      try { hls?.destroy(); } catch { }
      setHlsInstance(null);
      reset();
    };
  }, [
    selectedHlsUrl,
    selectedCandidate,
    selectedServer,
    shouldBlockStream,
    pushDiag,
    applyCandidatesPreservingSelection,
    setResolverError,
    scheduleResolveRecovery,
    resetRecoveryState,
  ]);

  const prettyStart = formatStartTimeAr(match?.match_start);
  const streamOpenLabel = formatTimeOnlyAr(streamOpenMs);
  const streamStartNotice = streamOpenLabel
    ? `سيبدأ البث في الساعة ${streamOpenLabel} (قبل ساعة المباراة بنصف ساعة)`
    : "سيبدأ البث قبل ساعة المباراة بنصف ساعة";
  const noStreamLabel = selectedUrl ? NO_STREAM_SELECTED_SERVER_MESSAGE : "لا يوجد بث";
  const home = match?.home_team ?? "الفريق الأول";
  const away = match?.away_team ?? "الفريق الثاني";

  if (loading) return <div className="text-white text-center mt-20">جاري تحميل البث...</div>;
  if (errMsg) return <div className="text-white text-center mt-20">{errMsg}</div>;

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-5xl mx-auto">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button onClick={() => router.replace("/")} className="text-gray-400 hover:text-white">Back Home</button>
          <Link href="/test" className="text-blue-400 hover:text-blue-300 font-bold text-sm">Test</Link>
        </div>

        <div className="mb-4 rounded-2xl border border-gray-800 bg-gradient-to-r from-[#1b1b1b] via-[#111111] to-[#1b1b1b] p-5 shadow-2xl">
          <div className="flex flex-col items-center text-center gap-2">
            <div className="text-2xl sm:text-3xl font-black">لا يوجد اعلانات</div>
            <div className="text-sm sm:text-base text-gray-300">كبر الفيديو وعييييش</div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {serverOptions.map((s) => {
            const hasUrl = !!s.url && isValidHttpUrl(s.url);
            const health: ServerHealthState = hasUrl ? serverHealth[s.n] ?? "ok" : "down";
            const ok = hasUrl;
            const subtitle = !ok || health === "down" ? "لا يوجد بث" : null;
            return (
              <button
                key={s.n}
                onClick={() => ok && setSelectedServer(s.n)}
                disabled={!ok}
                className={[
                  "px-4 py-2 rounded-xl font-black text-sm border transition-all min-w-[108px] text-center",
                  selectedServer === s.n && ok
                    ? "bg-blue-600/20 text-blue-300 border-blue-600/50"
                    : ok
                      ? "bg-[#121212] text-gray-200 border-gray-800 hover:border-blue-600/40"
                      : "bg-[#0f0f0f] text-gray-500 border-gray-900 cursor-not-allowed",
                ].join(" ")}
              >
                <div>{s.label}</div>
                {subtitle ? <div className="mt-0.5 text-[10px] font-semibold text-gray-400">{subtitle}</div> : null}
              </button>
            );
          })}
        </div>

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
        {playerError ? <div className="mt-2 text-xs text-amber-200 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">{playerError}</div> : null}

        {diagEnabled ? (
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

