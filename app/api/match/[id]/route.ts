import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string }> };
type MatchApiRow = {
  id: number;
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
  "id,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,stream_url_6,stream_url_7,match_start,status_key";
const SELECT_LEGACY =
  "id,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,match_start,status_key";
const RESOLVE_TIMEOUT_MS = 4500;
const RESOLVE_CACHE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX = 250;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type StreamResolveEntry = {
  expiresAt: number;
  primary: string | null;
  candidates: string[];
};
const streamResolveCache = new Map<string, StreamResolveEntry>();

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

export async function GET(req: Request, ctx: Ctx) {
  const { id: fromParams } = await ctx.params;
  const raw = fromParams ?? extractIdFromPath(req);
  const id = raw ? Number.parseInt(raw, 10) : NaN;

  if (!raw || !Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id", raw }, { status: 400 });
  }

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const res = NextResponse.json(data as MatchApiRow);
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  return res;
}
