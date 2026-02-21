import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";

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
};

const SELECT_WITH_SERVER_7 =
  "id,match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,stream_url_6,stream_url_7,match_start,status_key";
const SELECT_LEGACY =
  "id,match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,match_start,status_key";
const RESOLVE_TIMEOUT_MS = 4500;
const RESOLVE_CACHE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX = 250;
const SERVER5_REFRESH_TOTAL_BUDGET_MS = 2200;
const SERVER5_REFRESH_REQUEST_TIMEOUT_MS = 1200;
const SERVER5_REFRESH_CACHE_TTL_MS = 90_000;
const SERVER5_REFRESH_PREMATCH_WINDOW_MS = 90 * 60 * 1000;
const SERVER5_REFRESH_POSTMATCH_WINDOW_MS = 3 * 60 * 60 * 1000;
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
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
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

  const res = NextResponse.json(payload);
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  res.headers.set("x-server5-refresh", shouldRefreshServer5 ? server5RefreshStatus : "skip");
  res.headers.set("x-server5-refresh-ms", String(shouldRefreshServer5 ? server5RefreshMs : 0));
  return res;
}
