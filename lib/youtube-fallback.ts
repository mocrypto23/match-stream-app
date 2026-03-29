import axios from "axios";

import type { StreamProviderId, StreamSourceStatus } from "@/lib/stream-source-types";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const YOUTUBE_POSITIVE_CACHE_TTL_MS = 10 * 60_000;
const YOUTUBE_NEGATIVE_CACHE_TTL_MS = 60_000;
const YOUTUBE_FETCH_TIMEOUT_MS = 3_500;
const YOUTUBE_MAX_CRAWL_PAGES = 6;
const YOUTUBE_MAX_CRAWL_DEPTH = 2;

type YouTubeFallback = {
  embedUrl: string;
  watchUrl: string | null;
  via: string;
  detectedAt: number;
};

type CacheEntry = {
  value: YouTubeFallback | null;
  expiresAt: number;
};

const youtubeFallbackCache = new Map<string, CacheEntry>();

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function canonicalizeUrl(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    return parsed.toString().toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function decodeLooseHtml(text: string) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/gi, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
}

function resolveMatchParamValue(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    return (
      String(parsed.searchParams.get("match") || "").trim() ||
      String(parsed.searchParams.get("m") || "").trim() ||
      String(parsed.searchParams.get("id") || "").trim()
    );
  } catch {
    return "";
  }
}

function interpolateTemplateUrl(rawUrl: string, baseUrl: string) {
  const rawValue = decodeLooseHtml(String(rawUrl || "").trim());
  if (!rawValue.includes("${")) return rawValue;
  const matchValue = resolveMatchParamValue(baseUrl);
  const encodedMatchValue = encodeURIComponent(matchValue);
  return rawValue
    .replace(/\$\{\s*encodeURIComponent\s*\(\s*matchId\s*\)\s*\}/gi, encodedMatchValue)
    .replace(/\$\{\s*matchId\s*\}/gi, matchValue)
    .replace(/\$\{\s*encodeURIComponent\s*\(\s*urlParams\.get\(['"]match['"]\)\s*\)\s*\}/gi, encodedMatchValue)
    .replace(/\$\{\s*urlParams\.get\(['"]match['"]\)\s*\}/gi, matchValue)
    .replace(/\$\{\s*encodeURIComponent\s*\(\s*params\.get\(['"]match['"]\)\s*\)\s*\}/gi, encodedMatchValue)
    .replace(/\$\{\s*params\.get\(['"]match['"]\)\s*\}/gi, matchValue);
}

function buildVideoEmbedUrl(videoId: string) {
  const safeId = String(videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(safeId)) return "";
  return `https://www.youtube-nocookie.com/embed/${safeId}?autoplay=1&playsinline=1&rel=0`;
}

function buildChannelEmbedUrl(channelId: string) {
  const safeId = String(channelId || "").trim();
  if (!/^UC[A-Za-z0-9_-]{20,}$/.test(safeId)) return "";
  return `https://www.youtube.com/embed/live_stream?channel=${safeId}&autoplay=1&playsinline=1&rel=0`;
}

function normalizeYouTubeCandidate(rawValue: string) {
  const value = decodeLooseHtml(String(rawValue || "").trim());
  if (!value) return null;

  const directVideoId =
    String(value.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim() ||
    String(value.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim() ||
    String(value.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim() ||
    String(value.match(/youtube\.com\/live\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim() ||
    String(value.match(/ytimg\.com\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim();
  if (directVideoId) {
    return {
      embedUrl: buildVideoEmbedUrl(directVideoId),
      watchUrl: `https://www.youtube.com/watch?v=${directVideoId}`,
    };
  }

  const directChannelId =
    String(value.match(/youtube\.com\/embed\/live_stream\?[^"'`\s<>]*channel=([^&"'`\s<>]+)/i)?.[1] || "").trim() ||
    String(value.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})/i)?.[1] || "").trim();
  if (directChannelId) {
    return {
      embedUrl: buildChannelEmbedUrl(directChannelId),
      watchUrl: `https://www.youtube.com/channel/${directChannelId}`,
    };
  }

  const normalized = normalizeHttpUrl(value.startsWith("//") ? `https:${value}` : value);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (!(host === "youtu.be" || host.endsWith(".youtube.com") || host.endsWith(".youtube-nocookie.com"))) {
      return null;
    }

    const videoId =
      String(parsed.searchParams.get("v") || "").trim() ||
      String(parsed.pathname.match(/\/embed\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim() ||
      String(parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})$/i)?.[1] || "").trim() ||
      String(parsed.pathname.match(/\/live\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim() ||
      String(parsed.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/i)?.[1] || "").trim();
    if (videoId) {
      return {
        embedUrl: buildVideoEmbedUrl(videoId),
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      };
    }

    const channelId = String(parsed.searchParams.get("channel") || "").trim();
    if (channelId) {
      return {
        embedUrl: buildChannelEmbedUrl(channelId),
        watchUrl: `https://www.youtube.com/channel/${channelId}`,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function extractYouTubeFromText(text: string) {
  const decoded = decodeLooseHtml(text);
  const directPatterns = [
    /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s"'`<>)]*v=[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/live\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /https?:\/\/youtu\.be\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /https?:\/\/(?:i\.)?ytimg\.com\/vi(?:_webp)?\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
    /\/\/youtu\.be\/[A-Za-z0-9_-]{11}[^\s"'`<>)]*/gi,
  ];

  for (const pattern of directPatterns) {
    for (const match of decoded.matchAll(pattern)) {
      const resolved = normalizeYouTubeCandidate(String(match[0] || "").trim());
      if (resolved?.embedUrl) return resolved;
    }
  }

  const inlineVideoIdPatterns = [
    /["']videoId["']\s*[:=]\s*["']([A-Za-z0-9_-]{11})["']/gi,
    /data-video-id=["']([A-Za-z0-9_-]{11})["']/gi,
  ];
  for (const pattern of inlineVideoIdPatterns) {
    for (const match of decoded.matchAll(pattern)) {
      const videoId = String(match[1] || "").trim();
      const embedUrl = buildVideoEmbedUrl(videoId);
      if (embedUrl) {
        return {
          embedUrl,
          watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        };
      }
    }
  }

  const channelPattern = /["']channel(?:Id)?["']\s*[:=]\s*["'](UC[A-Za-z0-9_-]{20,})["']/gi;
  for (const match of decoded.matchAll(channelPattern)) {
    const channelId = String(match[1] || "").trim();
    const embedUrl = buildChannelEmbedUrl(channelId);
    if (embedUrl) {
      return {
        embedUrl,
        watchUrl: `https://www.youtube.com/channel/${channelId}`,
      };
    }
  }

  return null;
}

function resolveFollowUrl(rawUrl: string, baseUrl: string) {
  const value = interpolateTemplateUrl(rawUrl, baseUrl);
  if (!value) return "";
  try {
    const absolute = new URL(value.startsWith("//") ? `https:${value}` : value, baseUrl).toString();
    return normalizeHttpUrl(absolute);
  } catch {
    return "";
  }
}

function extractFollowUrls(text: string, baseUrl: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const parsedBase = (() => {
    try {
      return new URL(baseUrl);
    } catch {
      return null;
    }
  })();

  const push = (rawUrl: string) => {
    const absolute = resolveFollowUrl(rawUrl, baseUrl);
    if (!absolute) return;
    const key = canonicalizeUrl(absolute);
    if (!key || seen.has(key)) return;
    try {
      const parsed = new URL(absolute);
      const pathname = String(parsed.pathname || "").toLowerCase();
      const sameHost = parsedBase ? parsed.hostname === parsedBase.hostname : false;
      const interestingPath =
        pathname.includes("/player") ||
        pathname.includes("/embed") ||
        pathname.includes("/frame") ||
        pathname.includes("/watch") ||
        pathname.includes("/live") ||
        pathname.includes("/video") ||
        pathname.includes("/playerv") ||
        pathname.endsWith(".php") ||
        pathname.endsWith(".html") ||
        pathname.endsWith(".js");
      if (!sameHost && !interestingPath) return;
      seen.add(key);
      out.push(absolute);
    } catch {}
  };

  const decoded = decodeLooseHtml(text);
  for (const match of decoded.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    push(String(match[1] || "").trim());
  }
  for (const match of decoded.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const scriptUrl = String(match[1] || "").trim();
    if (/player|embed|youtube|final|rmp|v3|frame/i.test(scriptUrl)) {
      push(scriptUrl);
    }
  }
  for (const match of decoded.matchAll(/https?:\/\/[^"'`\s<>]+/gi)) {
    push(String(match[0] || "").trim());
  }
  for (const match of decoded.matchAll(/(?:playerv\d+\.php[^"'`\s<>]*|frame\.php[^"'`\s<>]*|embed[^"'`\s<>]*\.(?:php|html))/gi)) {
    push(String(match[0] || "").trim());
  }
  return out;
}

function extractPlayervRuntimeUrl(text: string, baseUrl: string) {
  const decoded = decodeLooseHtml(text);
  const patterns = [
    /playerUrl\s*=\s*`([^`]*\/playerv\d+\.php\?[^`]+)`/gi,
    /https?:\/\/[^"'`\s<>]+\/playerv\d+\.php\?[^"'`\s<>]+/gi,
  ];

  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const candidate = String(match[1] || match[0] || "").trim();
      const resolved = resolveFollowUrl(candidate, baseUrl);
      if (resolved) return resolved;
    }
  }

  return "";
}

async function fetchText(url: string, referrerUrl: string) {
  try {
    const response = await axios.get<string>(url, {
      responseType: "text",
      timeout: YOUTUBE_FETCH_TIMEOUT_MS,
      maxRedirects: 4,
      validateStatus: () => true,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/javascript,application/javascript,*/*;q=0.8",
        "accept-language": "ar,en;q=0.9",
        referer: referrerUrl || url,
      },
    });
    if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) return "";
    return String(response.data || "");
  } catch {
    return "";
  }
}

async function resolvePlayervYouTubeFallback(sourceUrl: string) {
  const normalizedSourceUrl = normalizeHttpUrl(sourceUrl);
  if (!normalizedSourceUrl) return null;
  if (!/\/hard\/|\/playerv\d+\.php/i.test(normalizedSourceUrl)) return null;

  const sourcePageText = await fetchText(normalizedSourceUrl, normalizedSourceUrl);
  if (!sourcePageText) return null;

  const playervRuntimeUrl =
    /\/playerv\d+\.php/i.test(normalizedSourceUrl)
      ? normalizedSourceUrl
      : extractPlayervRuntimeUrl(sourcePageText, normalizedSourceUrl);
  if (!playervRuntimeUrl) return null;

  const playervText = await fetchText(playervRuntimeUrl, normalizedSourceUrl);
  if (!playervText) return null;

  const extracted = extractYouTubeFromText(playervText);
  if (!extracted?.embedUrl) return null;

  return {
    ...extracted,
    via: "playerv-html",
    detectedAt: Date.now(),
  } satisfies YouTubeFallback;
}

function readCache(sourceUrl: string): YouTubeFallback | null | undefined {
  const key = canonicalizeUrl(sourceUrl);
  if (!key) return undefined;
  const cached = youtubeFallbackCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    youtubeFallbackCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function writeCache(sourceUrl: string, value: YouTubeFallback | null) {
  const key = canonicalizeUrl(sourceUrl);
  if (!key) return value;
  youtubeFallbackCache.set(key, {
    value,
    expiresAt: Date.now() + (value ? YOUTUBE_POSITIVE_CACHE_TTL_MS : YOUTUBE_NEGATIVE_CACHE_TTL_MS),
  });
  return value;
}

export async function resolveYouTubeFallback(sourceUrl: string) {
  const normalizedSourceUrl = normalizeHttpUrl(sourceUrl);
  if (!normalizedSourceUrl) return null;

  const cached = readCache(normalizedSourceUrl);
  if (cached !== undefined) return cached;

  const direct = normalizeYouTubeCandidate(normalizedSourceUrl);
  if (direct?.embedUrl) {
    return writeCache(normalizedSourceUrl, {
      ...direct,
      via: "direct",
      detectedAt: Date.now(),
    });
  }

  const playervFallback = await resolvePlayervYouTubeFallback(normalizedSourceUrl);
  if (playervFallback?.embedUrl) {
    return writeCache(normalizedSourceUrl, playervFallback);
  }

  const visited = new Set<string>();
  const queue: Array<{ url: string; referrerUrl: string; depth: number }> = [
    { url: normalizedSourceUrl, referrerUrl: normalizedSourceUrl, depth: 0 },
  ];
  let pagesFetched = 0;

  while (queue.length && pagesFetched < YOUTUBE_MAX_CRAWL_PAGES) {
    const next = queue.shift();
    if (!next) break;
    const key = canonicalizeUrl(next.url);
    if (!key || visited.has(key)) continue;
    visited.add(key);
    pagesFetched += 1;

    const text = await fetchText(next.url, next.referrerUrl);
    if (!text) continue;

    const extracted = extractYouTubeFromText(text);
    if (extracted?.embedUrl) {
      return writeCache(normalizedSourceUrl, {
        ...extracted,
        via: next.depth === 0 ? "page-html" : "nested-html",
        detectedAt: Date.now(),
      });
    }

    const playervRuntimeUrl = extractPlayervRuntimeUrl(text, next.url);
    if (playervRuntimeUrl) {
      const playervKey = canonicalizeUrl(playervRuntimeUrl);
      if (playervKey && !visited.has(playervKey)) {
        queue.unshift({
          url: playervRuntimeUrl,
          referrerUrl: next.url,
          depth: next.depth + 1,
        });
      }
    }

    if (next.depth >= YOUTUBE_MAX_CRAWL_DEPTH) continue;
    for (const followUrl of extractFollowUrls(text, next.url)) {
      const followKey = canonicalizeUrl(followUrl);
      if (!followKey || visited.has(followKey)) continue;
      queue.push({
        url: followUrl,
        referrerUrl: next.url,
        depth: next.depth + 1,
      });
    }
  }

  return writeCache(normalizedSourceUrl, null);
}

function shouldTryYoutubeFallback(reason: string, currentSource: string | null | undefined) {
  const normalizedReason = String(reason || "").trim().toLowerCase();
  const normalizedCurrentSource = String(currentSource || "").trim().toLowerCase();
  if (normalizedCurrentSource.includes("youtube.com") || normalizedCurrentSource.includes("youtu.be")) return true;
  if (!normalizedReason) return true;
  if (normalizedReason === "not-bootstrapped") return false;
  return (
    normalizedReason.includes("manifest") ||
    normalizedReason.includes("iframe") ||
    normalizedReason.includes("candidate") ||
    normalizedReason.includes("runtime") ||
    normalizedReason.includes("missing-source") ||
    normalizedReason.includes("unavailable") ||
    normalizedReason.includes("agent-unreachable")
  );
}

export async function maybeBuildYouTubeFallbackStatus<
  TProvider extends StreamProviderId,
  TLabel extends string,
  TOrder extends number,
>(input: {
  provider: TProvider;
  label: TLabel;
  order: TOrder;
  matchId: number;
  sourceUrl: string | null;
  currentSource?: string | null;
  reason?: string | null;
  updatedAt?: string | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim();
  if (!sourceUrl) return null;
  if (!shouldTryYoutubeFallback(input.reason || "", input.currentSource)) return null;

  const fallback = await resolveYouTubeFallback(sourceUrl);
  if (!fallback?.embedUrl) return null;

  return {
    provider: input.provider,
    mode: "youtube",
    matchId: input.matchId,
    sourceUrl,
    state: "ready",
    playlistUrl: fallback.embedUrl,
    reason: "youtube-embed",
    currentSource: fallback.watchUrl || fallback.embedUrl,
    youtubeEmbedUrl: fallback.embedUrl,
    updatedAt: input.updatedAt || new Date(fallback.detectedAt).toISOString(),
    label: input.label,
    order: input.order,
    phase: "ready",
    progressPct: 100,
  } satisfies StreamSourceStatus & { provider: TProvider; label: TLabel; order: TOrder };
}
