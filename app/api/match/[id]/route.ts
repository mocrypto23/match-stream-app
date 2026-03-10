import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";
import { getRuntimeRepackFlags } from "@/lib/repack-flags";
import { buildMatchR2Status } from "@/lib/r2-status";
import { listServerCapabilities } from "@/lib/server-capabilities";
import { computeMatchWindowState, getMatchWindowConfig, parseMatchStartMs } from "@/lib/match-window";
import {
  getSlotServerIdForUiServer,
  getUiServerIdForSlotServer,
  getSlotSourceUrlFromRow,
  isValidHttpUrl as isAllowedBootstrapSourceUrl,
  type SlotServerId,
  type UiServerId,
} from "@/lib/server-source-policy";
import { getServerStreamMode } from "@/lib/stream-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string }> };
type MatchApiRow = {
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
  stream_url_7?: string | null;
  match_start?: string | null;
  status_key?: string | null;
  match_day?: string | null;
};

const SELECT_WITH_SERVER_7 =
  "id,match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,stream_url_6,stream_url_7,match_start,status_key,match_day";
const SELECT_LEGACY =
  "id,match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,match_start,status_key,match_day";
const RESOLVE_TIMEOUT_MS = 4500;
const RESOLVE_CACHE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX = 250;
const SERVER5_REFRESH_TOTAL_BUDGET_MS = 2200;
const SERVER5_REFRESH_REQUEST_TIMEOUT_MS = 1200;
const SERVER5_REFRESH_CACHE_TTL_MS = 90_000;
const SERVER5_REFRESH_PREMATCH_WINDOW_MS = 90 * 60 * 1000;
const SERVER5_REFRESH_POSTMATCH_WINDOW_MS = 3 * 60 * 60 * 1000;
const DUPLICATE_SIBLING_START_WINDOW_MS = 6 * 60 * 60 * 1000;
const MATCH_BOOTSTRAP_PRIME_TTL_MS = 10_000;
const MATCH_BOOTSTRAP_PRIME_TIMEOUT_MS = 1_200;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type StreamResolveEntry = {
  expiresAt: number;
  primary: string | null;
  candidates: string[];
};
type Server5RefreshStatus = "hit" | "miss" | "skip";
type Server5RefreshCacheEntry = {
  expiresAt: number;
  status: Server5RefreshStatus;
  streamUrl5: string | null;
};
const streamResolveCache = new Map<string, StreamResolveEntry>();
const server5RefreshCache = new Map<string, Server5RefreshCacheEntry>();
const matchBootstrapPrimeCache = new Map<string, number>();

const NON_STREAM_FILE_RE =
  /\.(?:css|js|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|ico|json|map|xml|mp4|webm|ts|m4s|mpd)(?:[?#]|$)/i;
const NON_STREAM_HOST_HINTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googletagmanager.com",
  "google-analytics.com",
  "cloudflareinsights.com",
  "dtscout.com",
  "crwdcntrl.net",
  "taboola.com",
  "outbrain.com",
];
const SERVER5_VALID_HOSTS = [
  "anewssport.fun",
  "ksohls.ru",
  "s-high.fun",
  "zxxxeeplay.fun",
  "codepcplay.fun",
  "playerai.site",
] as const;

function isValidHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim().replace(/&amp;/g, "&");
  if (!value) return null;
  if (/^(javascript:|data:|blob:|mailto:|tel:)/i.test(value)) return null;
  try {
    const u = new URL(value, baseUrl);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function canonicalUrl(raw: string) {
  const normalized = normalizeUrl(raw, raw);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    u.hash = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function isClearlyNonStreamUrl(url: string) {
  const s = String(url || "").toLowerCase();
  if (!s) return true;
  if (NON_STREAM_FILE_RE.test(s)) return true;
  return NON_STREAM_HOST_HINTS.some((h) => s.includes(h));
}

function looksLikePlayerUrl(url: string) {
  const s = String(url || "").toLowerCase();
  if (!/^https?:\/\//i.test(s)) return false;
  return /\/albaplayer\/|\/alba\.php|\/playerv2\.php(\?|$)|\/embed\b|\/player\b|\/tv\//i.test(s);
}

function isLikelyBeinMatchPage(url: string) {
  if (!isValidHttpUrl(url)) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    return host.endsWith("bein-live.com") && /\/matches\//i.test(path);
  } catch {
    return false;
  }
}

function extractUrlCandidatesFromHtml(html: string, baseUrl: string) {
  const out = new Set<string>();
  const srcAttrRe = /<(?:iframe|a|source|video)[^>]+(?:src|href|data-src)\s*=\s*["']([^"']+)["']/gi;
  const inlineAbsRe = /https?:\/\/[^"'`\s<>()]+/gi;
  const inlineFieldRe = /(?:src|source|url|file)\s*[:=]\s*["']([^"']+)["']/gi;

  for (const m of html.matchAll(srcAttrRe)) {
    const abs = normalizeUrl(m[1] || "", baseUrl);
    if (abs) out.add(abs);
  }
  for (const m of html.matchAll(inlineAbsRe)) {
    const abs = normalizeUrl(m[0] || "", baseUrl);
    if (abs) out.add(abs);
  }
  for (const m of html.matchAll(inlineFieldRe)) {
    const abs = normalizeUrl(m[1] || "", baseUrl);
    if (abs) out.add(abs);
  }
  return Array.from(out);
}

function scoreStreamCandidate(candidateUrl: string, sourceUrl: string) {
  const sourceCanonical = canonicalUrl(sourceUrl);
  const candidateCanonical = canonicalUrl(candidateUrl);
  if (!candidateCanonical) return -99999;
  if (candidateCanonical === sourceCanonical) return -99999;
  if (isClearlyNonStreamUrl(candidateCanonical)) return -99999;

  let score = 0;
  const s = candidateCanonical;

  if (/\/albaplayer\//i.test(s)) score += 1800;
  if (/\/alba\.php/i.test(s)) score += 1600;
  if (/\/playerv2\.php(\?|$)/i.test(s)) score += 1500;
  if (/\/embed\b/i.test(s)) score += 900;
  if (/\/player\b/i.test(s)) score += 750;
  if (/\/tv\//i.test(s)) score += 550;
  if (/yallashoot|yallashot|koora|kora/i.test(s)) score += 350;
  if (/\/matches\//i.test(s)) score -= 1200;
  if (/\/wp-content\/uploads\//i.test(s)) score -= 3000;
  if (/m3u8/i.test(s)) score -= 600;

  return score;
}

function normalizeTeamNameForCompare(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0610-\u061a]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function normalizeTeamAliasForCompare(value: unknown, opts?: { stripGeo?: boolean }) {
  let s = normalizeTeamNameForCompare(value);
  if (!s) return "";
  s = s
    .replace(/^(?:\u0646\u0627\u062f\u064a|\u0641\u0631\u064a\u0642|\u0627\u0644\u0634\u0628\u0627\u0628|\u0633\u064a\u062f\u0627\u062a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a\u0647|\u0645\u0646\u062a\u062e\u0628)/, "")
    .replace(/(?:club|fc|sc|u\d{1,2}|women|youth)$/g, "");
  if (opts?.stripGeo) {
    s = s.replace(
      /(?:\u0627\u0644\u0633\u0639\u0648\u062f\u064a|\u0627\u0644\u0645\u0635\u0631\u064a|\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0645\u063a\u0631\u0628\u064a|\u0627\u0644\u062c\u0632\u0627\u0626\u0631\u064a|\u0627\u0644\u0642\u0637\u0631\u064a|\u0627\u0644\u0643\u0648\u064a\u062a\u064a|\u0627\u0644\u0628\u062d\u0631\u064a\u0646\u064a|\u0627\u0644\u0639\u0645\u0627\u0646\u064a|\u0627\u0644\u0639\u0631\u0627\u0642\u064a|\u0627\u0644\u0633\u0648\u0631\u064a|\u0627\u0644\u0627\u0631\u062f\u0646\u064a|\u0627\u0644\u0623\u0631\u062f\u0646\u064a|\u0627\u0644\u0644\u0628\u0646\u0627\u0646\u064a|\u0627\u0644\u0644\u064a\u0628\u064a|\u0627\u0644\u062a\u0648\u0646\u0633\u064a|\u0627\u0644\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0627\u0644\u0645\u0648\u0631\u064a\u062a\u0627\u0646\u064a)$/g,
      ""
    );
  }
  // Unify known cross-source aliases to keep sibling stream enrichment consistent.
  if (/^(?:\u0627\u0644\u0646\u062c\u0645\u0627\u0644\u0627\u062d\u0645\u0631|\u0633\u0631\u0641\u064a\u0646\u0627\u0632\u0641\u064a\u0632\u062f\u0627|redstar(?:belgrade)?|crvenazvezda)$/i.test(s)) {
    return "redstarbelgrade";
  }
  if (/^(?:\u063a\u0644\u0637\u0647\u0633\u0631\u0627\u064a|\u062c\u0627\u0644\u0627\u062a\u0627\u0633\u0631\u0627\u064a|galatasaray)$/i.test(s)) {
    return "galatasaray";
  }
  if (
    /^(?:\u064a\u0627\u063a\u064a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|\u064a\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|\u062c\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u062c\u0627\u062c\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|jagiellonia(?:bialystok)?|bialystok)$/i.test(
      s
    )
  ) {
    return "jagielloniabialystok";
  }
  return s.trim();
}

function buildUnorderedTeamPairKey(home: unknown, away: unknown, opts?: { stripGeo?: boolean }) {
  const a = normalizeTeamAliasForCompare(home, opts);
  const b = normalizeTeamAliasForCompare(away, opts);
  if (!a || !b) return "";
  return [a, b].sort().join("|");
}

function matchStartMs(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (!value) return null as number | null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function areSiblingKickoffsClose(left: MatchApiRow, right: MatchApiRow) {
  const leftMs = matchStartMs(left.match_start);
  const rightMs = matchStartMs(right.match_start);
  if (leftMs === null || rightMs === null) return true;
  return Math.abs(leftMs - rightMs) <= DUPLICATE_SIBLING_START_WINDOW_MS;
}

function extractDayKeyFromRow(row: MatchApiRow) {
  const matchDay = String(row.match_day || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(matchDay)) return matchDay;
  const key = String(row.match_key || "");
  const fromKey = key.split("||")[0] || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) return fromKey;
  if (row.match_start) return getCairoDayKey(row.match_start);
  return getCairoDayKey();
}

function countPresentStreams(row: MatchApiRow) {
  const urls = [
    row.stream_url,
    row.stream_url_2,
    row.stream_url_3,
    row.stream_url_4,
    row.stream_url_5,
    row.stream_url_6,
    row.stream_url_7,
  ];
  return urls.reduce((n, u) => (isValidHttpUrl(u) ? n + 1 : n), 0);
}

function mergeMissingStreams(base: MatchApiRow, donor: MatchApiRow) {
  const next: MatchApiRow = { ...base };
  if (!isValidHttpUrl(next.stream_url) && isValidHttpUrl(donor.stream_url)) next.stream_url = donor.stream_url;
  if (!isValidHttpUrl(next.stream_url_2) && isValidHttpUrl(donor.stream_url_2)) next.stream_url_2 = donor.stream_url_2;
  if (!isValidHttpUrl(next.stream_url_3) && isValidHttpUrl(donor.stream_url_3)) next.stream_url_3 = donor.stream_url_3;
  if (!isValidHttpUrl(next.stream_url_4) && isValidHttpUrl(donor.stream_url_4)) next.stream_url_4 = donor.stream_url_4;
  if (!isValidHttpUrl(next.stream_url_5) && isValidHttpUrl(donor.stream_url_5)) next.stream_url_5 = donor.stream_url_5;
  if (!isValidHttpUrl(next.stream_url_6) && isValidHttpUrl(donor.stream_url_6)) next.stream_url_6 = donor.stream_url_6;
  if (!isValidHttpUrl(next.stream_url_7) && isValidHttpUrl(donor.stream_url_7)) next.stream_url_7 = donor.stream_url_7;
  if (!next.match_start && donor.match_start) next.match_start = donor.match_start;
  return next;
}

function getCairoDayKey(value?: string | null) {
  const target = value ? new Date(value) : new Date();
  const date = Number.isFinite(target.getTime()) ? target : new Date();
  return date.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

function sanitizeServer5Id(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (!/^[a-z0-9_-]{2,80}$/i.test(value)) return "";
  return value;
}

function extractServer5LandingId(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const u = new URL(rawUrl);
    const id = sanitizeServer5Id(String(u.searchParams.get("id") || ""));
    if (id) return id;
    const stream = sanitizeServer5Id(String(u.searchParams.get("stream") || ""));
    if (stream) return stream;
    const play = sanitizeServer5Id(String(u.searchParams.get("play") || ""));
    if (play) return play;
    return "";
  } catch {
    return "";
  }
}

function inferServer5AuthReadyFromId(landingId: string) {
  const id = String(landingId || "").toLowerCase();
  if (!id) return false;
  if (id.startsWith("yallalive")) return true;
  if (id.startsWith("premium")) return true;
  return false;
}

function isServer5RefreshEligible(row: MatchApiRow) {
  const status = String(row.status_key || "").toLowerCase();
  if (status === "live") return true;
  const startMs = row.match_start ? new Date(row.match_start).getTime() : NaN;
  if (!Number.isFinite(startMs)) return false;
  const now = Date.now();
  return now >= startMs - SERVER5_REFRESH_PREMATCH_WINDOW_MS && now <= startMs + SERVER5_REFRESH_POSTMATCH_WINDOW_MS;
}

function isKnownServer5Host(hostname: string) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return false;
  return SERVER5_VALID_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isLikelyServer5LandingUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (NON_STREAM_HOST_HINTS.some((hint) => host.includes(hint))) return false;
    const isLandingPath =
      /\/(?:yalla|watch)\.php$/i.test(path) ||
      /\/(?:player\/)?live\d+\.php$/i.test(path) ||
      /\/live\d+\.php$/i.test(path);
    if (!isLandingPath) return false;
    const id = extractServer5LandingId(rawUrl);
    if (!id) return false;
    if (isKnownServer5Host(host)) return true;
    return /^[a-z0-9.-]{4,253}$/i.test(host);
  } catch {
    return false;
  }
}

function extractAnewssportMatchPageUrlsFromHtml(html: string, baseUrl: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const text = String(html || "").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  const push = (rawHref: string) => {
    const abs = normalizeUrl(rawHref, baseUrl);
    if (!abs) return;
    if (!/^https?:\/\/(?:www\.)?anewssport\.fun\/matches\/[a-z0-9-]+\/?$/i.test(abs)) return;
    const key = canonicalUrl(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(abs);
  };
  for (const m of text.match(/https?:\/\/(?:www\.)?anewssport\.fun\/matches\/[a-z0-9-]+\/?/gi) || []) push(m);
  for (const m of text.match(/\/matches\/[a-z0-9-]+\/?/gi) || []) push(m);
  return out.slice(0, 8);
}

function extractAnewssportSnsEndpointFromHtml(html: string, baseUrl: string) {
  const text = String(html || "").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  const abs = text.match(/https?:\/\/[^"'`\s<>()]+\/wp-json\/sns\/v1\/links\?id=\d+/i)?.[0] || "";
  if (abs && isValidHttpUrl(abs)) return abs;
  const rel = text.match(/\/wp-json\/sns\/v1\/links\?id=\d+/i)?.[0] || "";
  if (!rel) return "";
  const resolved = normalizeUrl(rel, baseUrl);
  return resolved || "";
}

function extractServer5LandingUrlsFromHtml(html: string, baseUrl: string) {
  const out: Array<{ url: string; slot: number; source: "page" }> = [];
  const seen = new Set<string>();
  const text = String(html || "").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  const push = (rawHref: string) => {
    const abs = normalizeUrl(rawHref, baseUrl);
    if (!abs || !isLikelyServer5LandingUrl(abs)) return;
    const key = canonicalUrl(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ url: abs, slot: 0, source: "page" });
  };
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+\/(?:yalla|watch)\.php\?[^"'`\s<>()]*/gi) || []) push(m);
  for (const m of text.match(/\/(?:yalla|watch)\.php\?[^"'`\s<>()]*/gi) || []) push(m);
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+\/(?:player\/)?live\d+\.php(?:\?[^"'`\s<>()]*)?/gi) || []) push(m);
  for (const m of text.match(/\/(?:player\/)?live\d+\.php(?:\?[^"'`\s<>()]*)?/gi) || []) push(m);
  return out.slice(0, 10);
}

function extractServer5LandingUrlsFromSnsPayload(rawText: string, baseUrl: string) {
  const out: Array<{ url: string; slot: number; source: "sns" }> = [];
  const seen = new Set<string>();
  const push = (rawHref: string, slotHint = 0) => {
    const abs = normalizeUrl(rawHref, baseUrl);
    if (!abs || !isLikelyServer5LandingUrl(abs)) return;
    const key = canonicalUrl(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ url: abs, slot: slotHint, source: "sns" });
  };

  const text = String(rawText || "").trim();
  if (!text) return out;
  try {
    const parsed = JSON.parse(text) as { urls?: unknown } | null;
    const urls = Array.isArray(parsed?.urls) ? parsed.urls : [];
    urls.forEach((item, idx) => {
      if (typeof item !== "string") return;
      push(item, idx + 1);
    });
    if (out.length) return out.slice(0, 10);
  } catch {}

  let idx = 0;
  for (const m of text.match(/https?:\/\/[^"'`\s<>()]+\/(?:yalla|watch)\.php\?[^"'`\s<>()]*/gi) || []) {
    idx += 1;
    push(m, idx);
  }
  return out.slice(0, 10);
}

function stripTags(raw: string) {
  return String(raw || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAnewssportEventTeamsFromHtml(html: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(html || "").matchAll(/class=["'][^"']*EventTeamName[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)) {
    const text = stripTags(String(m[1] || ""));
    if (!text) continue;
    const key = normalizeTeamNameForCompare(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

function isExactTeamMatch(pageTeams: string[], homeTeam: string | null | undefined, awayTeam: string | null | undefined) {
  const home = normalizeTeamNameForCompare(homeTeam);
  const away = normalizeTeamNameForCompare(awayTeam);
  if (!home || !away || !pageTeams.length) return false;
  const normalizedPageTeams = pageTeams.map((team) => normalizeTeamNameForCompare(team)).filter(Boolean);
  if (normalizedPageTeams.length < 2) return false;
  const hasHome = normalizedPageTeams.includes(home);
  const hasAway = normalizedPageTeams.includes(away);
  return hasHome && hasAway;
}

function scoreServer5RefreshCandidate(input: {
  url: string;
  slot: number;
  source: "current" | "page" | "sns";
  teamExact: boolean;
}) {
  let score = 0;
  const id = extractServer5LandingId(input.url).toLowerCase();
  if (input.teamExact) score += 450;
  if (input.source === "sns") score += 220;
  else if (input.source === "page") score += 130;
  else score += 45;

  if (input.slot === 2) score += 260;
  else if (input.slot === 1) score += 200;
  else if (input.slot === 3) score += 150;
  else if (input.slot === 4) score += 120;

  if (inferServer5AuthReadyFromId(id)) score += 80;
  if (id.startsWith("cnpremium")) score -= 30;
  if (/^\d{2,8}$/.test(id)) score -= 20;

  try {
    const host = new URL(input.url).hostname.toLowerCase();
    if (host === "ksohls.ru" || host.endsWith(".ksohls.ru")) score += 45;
    if (host === "anewssport.fun" || host.endsWith(".anewssport.fun")) score += 30;
  } catch {}

  return score;
}

function trimServer5RefreshCache(now = Date.now()) {
  for (const [key, value] of server5RefreshCache.entries()) {
    if (value.expiresAt <= now) server5RefreshCache.delete(key);
  }
  if (server5RefreshCache.size <= 320) return;
  while (server5RefreshCache.size > 220) {
    const firstKey = server5RefreshCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    server5RefreshCache.delete(firstKey);
  }
}

function getServer5RefreshCacheEntry(cacheKey: string) {
  const key = String(cacheKey || "").trim().toLowerCase();
  if (!key) return null as Server5RefreshCacheEntry | null;
  const now = Date.now();
  const cached = server5RefreshCache.get(key);
  if (!cached || cached.expiresAt <= now) {
    if (cached) server5RefreshCache.delete(key);
    return null;
  }
  return cached;
}

function setServer5RefreshCacheEntry(cacheKey: string, status: Server5RefreshStatus, streamUrl5: string | null) {
  const key = String(cacheKey || "").trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  server5RefreshCache.set(key, {
    expiresAt: now + SERVER5_REFRESH_CACHE_TTL_MS,
    status,
    streamUrl5: streamUrl5 && isValidHttpUrl(streamUrl5) ? streamUrl5 : null,
  });
  trimServer5RefreshCache(now);
}

function trimMatchBootstrapPrimeCache(now = Date.now()) {
  for (const [key, expiresAt] of matchBootstrapPrimeCache.entries()) {
    if (expiresAt <= now) matchBootstrapPrimeCache.delete(key);
  }
}

function getBootstrapPrimeUiServers(row: MatchApiRow) {
  const slotServers: SlotServerId[] = [1, 2, 3, 4];
  return slotServers
    .filter((slotServer) => {
      const sourceUrl = getSlotSourceUrlFromRow(row, slotServer);
      return isAllowedBootstrapSourceUrl(sourceUrl);
    })
    .map((slotServer) => getUiServerIdForSlotServer(slotServer));
}

function queueBootstrapPrime(req: Request, matchId: number, uiServers: UiServerId[]) {
  if (!Number.isFinite(matchId) || matchId <= 0) return false;
  const safeUiServers = [...new Set(uiServers.filter((uiServer) => Number.isFinite(uiServer)))].sort((a, b) => a - b) as UiServerId[];
  if (!safeUiServers.length) return false;

  const now = Date.now();
  trimMatchBootstrapPrimeCache(now);
  const cacheKey = `${matchId}|${safeUiServers.join(",")}`;
  const cachedUntil = matchBootstrapPrimeCache.get(cacheKey) || 0;
  if (cachedUntil > now) return false;
  matchBootstrapPrimeCache.set(cacheKey, now + MATCH_BOOTSTRAP_PRIME_TTL_MS);

  const endpoint = new URL("/api/repack/bootstrap", req.url).toString();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MATCH_BOOTSTRAP_PRIME_TIMEOUT_MS);
  void fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      matchId,
      uiServers: safeUiServers,
    }),
  })
    .catch(() => null)
    .finally(() => {
      clearTimeout(timeoutId);
    });
  return true;
}

function withQueuedBootstrapStatus(status: Awaited<ReturnType<typeof buildMatchR2Status>>, row: MatchApiRow, uiServers: UiServerId[]) {
  if (!status?.servers?.length) return status;
  const queuedSlots = new Set(uiServers.map((uiServer) => getSlotServerIdForUiServer(uiServer)));
  const updatedAt = new Date().toISOString();
  return {
    ...status,
    updatedAt,
    servers: status.servers.map((entry) => {
      const sourceUrl = getSlotSourceUrlFromRow(row, entry.slotServer);
      if (!queuedSlots.has(entry.slotServer)) return entry;
      if (!isAllowedBootstrapSourceUrl(sourceUrl)) return entry;
      if (entry.state !== "down") return entry;
      if (
        entry.reason === "missing-source" ||
        entry.reason === "source-not-allowed" ||
        entry.reason === "blocked-outside-window" ||
        entry.reason.startsWith("seed-rejected:") ||
        entry.reason.startsWith("seed-stalled:") ||
        entry.resolverState === "no-candidate" ||
        entry.resolverState === "probe-failed"
      ) {
        return entry;
      }
      return {
        ...entry,
        state: "warming" as const,
        reason: "bootstrap-queued",
        updatedAt,
      };
    }),
  };
}

function buildServer5RefreshCacheKey(row: MatchApiRow, idHint?: number | null) {
  const matchKey = cleanMatchKey(row.match_key) || `id:${Number.isFinite(idHint as number) ? Number(idHint) : 0}`;
  const day = getCairoDayKey(row.match_start || null);
  return `${matchKey}|${day}|server5`;
}

async function fetchTextWithinDeadline(url: string, deadlineAtMs: number) {
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 120) return null as { ok: boolean; status: number; text: string; finalUrl: string; ct: string } | null;
  const timeoutMs = Math.max(180, Math.min(SERVER5_REFRESH_REQUEST_TIMEOUT_MS, remaining - 40));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ar,en-US;q=0.9,en;q=0.8",
      },
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url, ct };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveServer5RefreshedLanding(
  row: MatchApiRow,
  idHint?: number | null
): Promise<{ status: Server5RefreshStatus; streamUrl5: string | null }> {
  const currentUrl = isValidHttpUrl(row.stream_url_5) ? row.stream_url_5 : null;
  if (!currentUrl) return { status: "skip", streamUrl5: null };
  if (!isServer5RefreshEligible(row)) return { status: "skip", streamUrl5: currentUrl };

  const cacheKey = buildServer5RefreshCacheKey(row, idHint);
  const cached = getServer5RefreshCacheEntry(cacheKey);
  if (cached) return { status: cached.status, streamUrl5: cached.streamUrl5 || currentUrl };

  const deadlineAt = Date.now() + SERVER5_REFRESH_TOTAL_BUDGET_MS;
  const ranked = new Map<string, { url: string; score: number }>();
  const addCandidate = (candidate: { url: string; slot: number; source: "current" | "page" | "sns"; teamExact: boolean }) => {
    const normalized = normalizeUrl(candidate.url, candidate.url);
    if (!normalized || !isLikelyServer5LandingUrl(normalized)) return;
    const key = canonicalUrl(normalized);
    if (!key) return;
    const score = scoreServer5RefreshCandidate({ ...candidate, url: normalized });
    const existing = ranked.get(key);
    if (!existing || score > existing.score) ranked.set(key, { url: normalized, score });
  };

  addCandidate({ url: currentUrl, slot: 0, source: "current", teamExact: false });

  const currentPage = await fetchTextWithinDeadline(currentUrl, deadlineAt);
  if (currentPage && (currentPage.ok || currentPage.status < 500) && currentPage.text) {
    const teams = extractAnewssportEventTeamsFromHtml(currentPage.text);
    const exactMatch = isExactTeamMatch(teams, row.home_team, row.away_team);
    addCandidate({ url: currentUrl, slot: 0, source: "current", teamExact: exactMatch });

    for (const landing of extractServer5LandingUrlsFromHtml(currentPage.text, currentPage.finalUrl)) {
      addCandidate({ url: landing.url, slot: landing.slot, source: landing.source, teamExact: exactMatch });
    }

    const snsEndpoint = extractAnewssportSnsEndpointFromHtml(currentPage.text, currentPage.finalUrl);
    if (snsEndpoint) {
      const snsPage = await fetchTextWithinDeadline(snsEndpoint, deadlineAt);
      if (snsPage?.text) {
        for (const landing of extractServer5LandingUrlsFromSnsPayload(snsPage.text, currentPage.finalUrl)) {
          addCandidate({ url: landing.url, slot: landing.slot, source: landing.source, teamExact: exactMatch });
        }
      }
    }
  }

  const hasStrongMatch = Array.from(ranked.values()).some((item) => item.score >= 650);
  if (!hasStrongMatch) {
    const terms = [String(row.home_team || "").trim(), String(row.away_team || "").trim()].filter(Boolean).slice(0, 2);
    const pageQueue: string[] = [];
    const pageSeen = new Set<string>();
    for (const term of terms) {
      if (Date.now() >= deadlineAt - 140) break;
      const searchUrl = `https://anewssport.fun/?s=${encodeURIComponent(term)}`;
      const searchPage = await fetchTextWithinDeadline(searchUrl, deadlineAt);
      if (!searchPage?.text) continue;
      const matchPages = extractAnewssportMatchPageUrlsFromHtml(searchPage.text, searchUrl);
      for (const pageUrl of matchPages) {
        const key = canonicalUrl(pageUrl);
        if (!key || pageSeen.has(key)) continue;
        pageSeen.add(key);
        pageQueue.push(pageUrl);
        if (pageQueue.length >= 4) break;
      }
      if (pageQueue.length >= 4) break;
    }

    for (const pageUrl of pageQueue) {
      if (Date.now() >= deadlineAt - 140) break;
      const matchPage = await fetchTextWithinDeadline(pageUrl, deadlineAt);
      if (!matchPage?.text) continue;
      const teams = extractAnewssportEventTeamsFromHtml(matchPage.text);
      const exactMatch = isExactTeamMatch(teams, row.home_team, row.away_team);
      if (!exactMatch) continue;

      for (const landing of extractServer5LandingUrlsFromHtml(matchPage.text, matchPage.finalUrl)) {
        addCandidate({ url: landing.url, slot: landing.slot, source: landing.source, teamExact: true });
      }

      const snsEndpoint = extractAnewssportSnsEndpointFromHtml(matchPage.text, matchPage.finalUrl);
      if (snsEndpoint) {
        const snsPage = await fetchTextWithinDeadline(snsEndpoint, deadlineAt);
        if (snsPage?.text) {
          for (const landing of extractServer5LandingUrlsFromSnsPayload(snsPage.text, matchPage.finalUrl)) {
            addCandidate({ url: landing.url, slot: landing.slot, source: landing.source, teamExact: true });
          }
        }
      }

      const hasExactSlot2 = Array.from(ranked.values()).some((item) => item.score >= 900);
      if (hasExactSlot2) break;
    }
  }

  const best = Array.from(ranked.values()).sort((a, b) => b.score - a.score)[0] || null;
  if (!best?.url) {
    setServer5RefreshCacheEntry(cacheKey, "miss", currentUrl);
    return { status: "miss", streamUrl5: currentUrl };
  }

  const bestCanonical = canonicalUrl(best.url);
  const currentCanonical = canonicalUrl(currentUrl);
  const status: Server5RefreshStatus = bestCanonical && bestCanonical !== currentCanonical ? "hit" : "miss";
  setServer5RefreshCacheEntry(cacheKey, status, best.url);
  return { status, streamUrl5: best.url };
}

function trimResolveCache(now = Date.now()) {
  for (const [k, v] of streamResolveCache.entries()) {
    if (v.expiresAt <= now) streamResolveCache.delete(k);
  }
  if (streamResolveCache.size <= RESOLVE_CACHE_MAX) return;
  const sorted = Array.from(streamResolveCache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const overflow = streamResolveCache.size - RESOLVE_CACHE_MAX;
  for (let i = 0; i < overflow; i++) {
    const key = sorted[i]?.[0];
    if (key) streamResolveCache.delete(key);
  }
}

async function resolveStreamCandidates(sourceUrl: string) {
  const key = canonicalUrl(sourceUrl) || sourceUrl.toLowerCase();
  const now = Date.now();
  const cached = streamResolveCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { primary: cached.primary, candidates: [...cached.candidates] };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    const upstream = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ar,en-US;q=0.9,en;q=0.8",
      },
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      const next: StreamResolveEntry = { primary: null, candidates: [], expiresAt: now + RESOLVE_CACHE_TTL_MS };
      streamResolveCache.set(key, next);
      trimResolveCache(now);
      return { primary: null, candidates: [] };
    }

    const html = await upstream.text();
    const finalUrl = upstream.url || sourceUrl;
    const rawCandidates = extractUrlCandidatesFromHtml(html, finalUrl);

    const sorted = rawCandidates
      .map((url) => ({
        url,
        score: scoreStreamCandidate(url, finalUrl),
      }))
      .filter((x) => x.score > -99999)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.url);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const candidate of sorted) {
      const c = canonicalUrl(candidate);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      deduped.push(candidate);
      if (deduped.length >= 18) break;
    }

    const primary = deduped.find((x) => looksLikePlayerUrl(x)) || null;
    const next: StreamResolveEntry = { primary, candidates: deduped, expiresAt: now + RESOLVE_CACHE_TTL_MS };
    streamResolveCache.set(key, next);
    trimResolveCache(now);
    return { primary, candidates: [...deduped] };
  } catch {
    return { primary: null, candidates: [] };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function hydrateStreamFallbacks(input: MatchApiRow) {
  const out: MatchApiRow = { ...input };
  const currentPrimary = isValidHttpUrl(out.stream_url) ? out.stream_url : null;
  if (!currentPrimary) return out;

  if (!isLikelyBeinMatchPage(currentPrimary) && looksLikePlayerUrl(currentPrimary)) return out;

  const resolved = await resolveStreamCandidates(currentPrimary);
  if (resolved.primary && looksLikePlayerUrl(resolved.primary)) {
    out.stream_url = resolved.primary;
  }

  return out;
}

function extractIdFromPath(req: Request) {
  const pathname = new URL(req.url).pathname;
  const parts = pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

function cleanMatchKey(raw: unknown) {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? v : null;
}

async function fetchMatchById(id: number) {
  let { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select(SELECT_WITH_SERVER_7)
    .eq("id", id)
    .maybeSingle();

  if (error && /stream_url_6|stream_url_7/i.test(error.message || "")) {
    const legacyRes = await supabaseAdmin
      .from("match-stream-app")
      .select(SELECT_LEGACY)
      .eq("id", id)
      .maybeSingle();

    error = legacyRes.error;
    data = legacyRes.data ? { ...legacyRes.data, stream_url_6: null, stream_url_7: null } : legacyRes.data;
  }

  return {
    data: (data ?? null) as MatchApiRow | null,
    error: (error ?? null) as { message: string } | null,
  };
}

async function fetchMatchByKey(matchKey: string) {
  let { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select(SELECT_WITH_SERVER_7)
    .eq("match_key", matchKey)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && /stream_url_6|stream_url_7/i.test(error.message || "")) {
    const legacyRes = await supabaseAdmin
      .from("match-stream-app")
      .select(SELECT_LEGACY)
      .eq("match_key", matchKey)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    error = legacyRes.error;
    data = legacyRes.data ? { ...legacyRes.data, stream_url_6: null, stream_url_7: null } : legacyRes.data;
  }

  return {
    data: (data ?? null) as MatchApiRow | null,
    error: (error ?? null) as { message: string } | null,
  };
}

async function fetchMatchesByDayKey(dayKey: string) {
  const safeDayKey = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDayKey)) return [] as MatchApiRow[];

  let { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select(SELECT_WITH_SERVER_7)
    .like("match_key", `${safeDayKey}||%`)
    .limit(300);

  if (error && /stream_url_6|stream_url_7/i.test(error.message || "")) {
    const legacyRes = await supabaseAdmin
      .from("match-stream-app")
      .select(SELECT_LEGACY)
      .like("match_key", `${safeDayKey}||%`)
      .limit(300);
    error = legacyRes.error;
    data = (legacyRes.data || []).map((r) => ({ ...r, stream_url_6: null, stream_url_7: null }));
  }

  if (error || !Array.isArray(data)) return [] as MatchApiRow[];
  return data as MatchApiRow[];
}

async function enrichWithDuplicateSiblingStreams(row: MatchApiRow) {
  const currentPair = buildUnorderedTeamPairKey(row.home_team, row.away_team);
  const currentLoosePair = buildUnorderedTeamPairKey(row.home_team, row.away_team, { stripGeo: true });
  if (!currentPair && !currentLoosePair) return row;
  const dayKey = extractDayKeyFromRow(row);
  const sameDayRows = await fetchMatchesByDayKey(dayKey);
  if (!sameDayRows.length) return row;

  const siblings = sameDayRows
    .filter((candidate) => Number(candidate.id) !== Number(row.id))
    .filter((candidate) => {
      if (!areSiblingKickoffsClose(row, candidate)) return false;
      const strictPair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team);
      if (currentPair && strictPair && strictPair === currentPair) return true;
      const loosePair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team, { stripGeo: true });
      return !!(currentLoosePair && loosePair && loosePair === currentLoosePair);
    });
  if (!siblings.length) return row;

  const donor = siblings.sort((a, b) => {
    const streamDelta = countPresentStreams(b) - countPresentStreams(a);
    if (streamDelta !== 0) return streamDelta;
    const startA = a.match_start ? new Date(a.match_start).getTime() : 0;
    const startB = b.match_start ? new Date(b.match_start).getTime() : 0;
    if (startB !== startA) return startB - startA;
    return Number(b.id || 0) - Number(a.id || 0);
  })[0];
  if (!donor) return row;
  return mergeMissingStreams(row, donor);
}

export async function GET(req: Request, ctx: Ctx) {
  const { id: fromParams } = await ctx.params;
  const requestUrl = new URL(req.url);
  const raw = fromParams ?? extractIdFromPath(req);
  const keyHint = cleanMatchKey(requestUrl.searchParams.get("k"));
  const s5Mode = String(requestUrl.searchParams.get("s5") || "").trim().toLowerCase();
  const shouldRefreshServer5 = s5Mode === "refresh";
  const id = raw ? Number.parseInt(raw, 10) : NaN;
  const hasValidId = Number.isFinite(id) && id > 0;

  if (!hasValidId && !keyHint) {
    return NextResponse.json({ error: "Invalid id", raw, key: keyHint }, { status: 400 });
  }

  let data: MatchApiRow | null = null;
  let error: { message: string } | null = null;
  if (hasValidId) {
    const byId = await fetchMatchById(id);
    data = byId.data;
    error = byId.error;
  }
  if (!error && !data && keyHint) {
    const byKey = await fetchMatchByKey(keyHint);
    data = byKey.data;
    error = byKey.error;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let payload = data as MatchApiRow;
  try {
    payload = await hydrateStreamFallbacks(payload);
  } catch {}
  try {
    payload = await enrichWithDuplicateSiblingStreams(payload);
  } catch {}

  let server5RefreshStatus: Server5RefreshStatus = "skip";
  let server5RefreshMs = 0;
  if (shouldRefreshServer5) {
    const startedAt = Date.now();
    try {
      const refreshed = await resolveServer5RefreshedLanding(payload, hasValidId ? id : null);
      server5RefreshStatus = refreshed.status;
      if (refreshed.streamUrl5 && isValidHttpUrl(refreshed.streamUrl5)) {
        payload = { ...payload, stream_url_5: refreshed.streamUrl5 };
      }
    } catch {
      server5RefreshStatus = "miss";
    } finally {
      server5RefreshMs = Math.max(0, Date.now() - startedAt);
    }
  }

  const repackFlags = getRuntimeRepackFlags();
  const streamMode = getServerStreamMode();
  let r2Status = await buildMatchR2Status({
    mode: streamMode,
    matchId: Number(payload.id),
    row: payload,
    repackBaseUrl: repackFlags.publicBaseUrl,
  });
  const matchWindow = computeMatchWindowState({
    nowMs: Date.now(),
    matchStartMs: parseMatchStartMs(payload.match_start),
    config: getMatchWindowConfig(),
  });
  if (streamMode === "r2_strict" && matchWindow.inWindow) {
    const bootstrapUiServers = getBootstrapPrimeUiServers(payload).filter((uiServer) => {
      const entry = r2Status?.servers?.find((item) => item.uiServer === uiServer);
      if (!entry) return true;
      if (entry.state === "ready" || entry.state === "warming") return false;
      if (
        entry.reason === "missing-source" ||
        entry.reason === "source-not-allowed" ||
        entry.reason === "blocked-outside-window" ||
        entry.reason.startsWith("seed-rejected:") ||
        entry.reason.startsWith("seed-stalled:") ||
        entry.resolverState === "no-candidate" ||
        entry.resolverState === "probe-failed"
      ) {
        return false;
      }
      return true;
    });
    if (bootstrapUiServers.length && queueBootstrapPrime(req, Number(payload.id), bootstrapUiServers)) {
      r2Status = withQueuedBootstrapStatus(r2Status, payload, bootstrapUiServers);
    }
  }
  const repackHints = {
    enabled: repackFlags.enabled,
    readPct: repackFlags.readPct,
    readPctByServer: Object.fromEntries(Array.from(repackFlags.readPctByServer.entries())),
    forceDisableServers: Array.from(repackFlags.forceDisableServers).sort((a, b) => a - b),
    repackServers: Array.from(repackFlags.repackServers).sort((a, b) => a - b),
    p2pServers: Array.from(repackFlags.p2pServers).sort((a, b) => a - b),
    publicBaseUrl: repackFlags.publicBaseUrl,
    capabilityRegistry: listServerCapabilities().map((item) => ({
      serverId: item.serverId,
      repackEligible: item.repackEligible,
      p2pEligible: item.p2pEligible,
      proxyAuthMode: item.proxyAuthMode,
      tokenMode: item.tokenMode,
      fallbackPolicy: item.fallbackPolicy,
      repackProfile: item.repackProfile,
    })),
  };

  const res = NextResponse.json({
    ...payload,
    stream_mode: streamMode,
    r2Status,
    repack: repackHints,
  });
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  res.headers.set("x-server5-refresh", shouldRefreshServer5 ? server5RefreshStatus : "skip");
  res.headers.set("x-server5-refresh-ms", String(shouldRefreshServer5 ? server5RefreshMs : 0));
  return res;
}


