import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = String(__ENV.BASE_URL || "https://tf-player.site").replace(/\/+$/, "");
const MATCH_ID = String(__ENV.MATCH_ID || "37687").trim();
const WATCH_PATH = String(__ENV.WATCH_PATH || `/watch/${MATCH_ID}`).trim();
const SERVER = Number.parseInt(String(__ENV.SERVER || "4"), 10);
const STREAM_FIELD = String(__ENV.STREAM_FIELD || "").trim();
const MANIFEST_URL = String(__ENV.MANIFEST_URL || "").trim();
const SOURCE_URL = String(__ENV.SOURCE_URL || "").trim();
const SEGMENTS_PER_LOOP = Math.max(1, Number.parseInt(String(__ENV.SEGMENTS_PER_LOOP || "2"), 10) || 2);
const LOOP_SLEEP_SEC = Math.max(0, Number.parseFloat(String(__ENV.LOOP_SLEEP_SEC || "1")) || 1);
const USER_AGENT = String(
  __ENV.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36"
);
const REQUEST_TIMEOUT = String(__ENV.REQUEST_TIMEOUT || "30s");

const playbackErrors = new Rate("playback_errors");
const manifestLatency = new Trend("manifest_latency_ms", true);
const segmentLatency = new Trend("segment_latency_ms", true);
const manifestFetches = new Counter("manifest_fetches");
const segmentFetches = new Counter("segment_fetches");

function parseStages(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [duration, targetStr] = part.split(":").map((x) => String(x || "").trim());
      const target = Number.parseInt(targetStr, 10);
      if (!duration || !Number.isFinite(target) || target < 0) return null;
      return { duration, target };
    })
    .filter(Boolean);
}

const stages = parseStages(String(__ENV.STAGES || ""));
const defaultVus = Math.max(1, Number.parseInt(String(__ENV.VUS || "20"), 10) || 20);
const defaultDuration = String(__ENV.DURATION || "2m");

export const options = stages.length
  ? {
      scenarios: {
        viewers: {
          executor: "ramping-vus",
          startVUs: 1,
          gracefulRampDown: "30s",
          stages,
        },
      },
      thresholds: {
        playback_errors: ["rate<0.05"],
        http_req_failed: ["rate<0.05"],
        http_req_duration: ["p(95)<3500"],
        manifest_latency_ms: ["p(95)<2500"],
        segment_latency_ms: ["p(95)<2500"],
      },
    }
  : {
      vus: defaultVus,
      duration: defaultDuration,
      thresholds: {
        playback_errors: ["rate<0.05"],
        http_req_failed: ["rate<0.05"],
        http_req_duration: ["p(95)<3500"],
        manifest_latency_ms: ["p(95)<2500"],
        segment_latency_ms: ["p(95)<2500"],
      },
    };

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function getServerField(serverNo) {
  const n = Number(serverNo);
  if (n === 1) return "stream_url";
  if (n === 2) return "stream_url_2";
  if (n === 3) return "stream_url_3";
  if (n === 4) return "stream_url_4";
  if (n === 5) return "stream_url_5";
  if (n === 6) return "stream_url_6";
  if (n === 7) return "stream_url_7";
  return "";
}

function toAbsolute(urlLike, base) {
  try {
    return new URL(urlLike, base).toString();
  } catch {
    return "";
  }
}

function getBaseOrigin() {
  try {
    return new URL(BASE_URL).origin;
  } catch {
    return BASE_URL;
  }
}

function buildHeaders(referrer) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
  };
  if (referrer) headers.Referer = referrer;
  return headers;
}

function buildProxyUrl(target, ref) {
  const params = [`url=${encodeURIComponent(target)}`];
  if (ref) params.push(`ref=${encodeURIComponent(ref)}`);
  return `${BASE_URL}/api/embed-proxy?${params.join("&")}`;
}

function maybeProxy(url, ref) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  if (raw.startsWith("/api/embed-proxy?")) return `${BASE_URL}${raw}`;
  if (raw.startsWith(`${BASE_URL}/api/embed-proxy?`)) return raw;

  if (raw.startsWith("/")) {
    const abs = toAbsolute(raw, BASE_URL);
    if (abs.includes("/api/embed-proxy?")) return abs;
  }

  if (!isHttpUrl(raw)) return "";

  const baseOrigin = getBaseOrigin();
  const targetOrigin = new URL(raw).origin;
  if (targetOrigin === baseOrigin && raw.includes("/api/embed-proxy?")) return raw;

  return buildProxyUrl(raw, ref || `${BASE_URL}${WATCH_PATH}`);
}

function pickSourceUrl(matchPayload) {
  if (SOURCE_URL && isHttpUrl(SOURCE_URL)) return SOURCE_URL;
  if (!matchPayload || typeof matchPayload !== "object") return "";

  const preferred = [];
  if (STREAM_FIELD) preferred.push(STREAM_FIELD);
  const mapped = getServerField(SERVER);
  if (mapped) preferred.push(mapped);
  preferred.push("stream_url_4", "stream_url_2", "stream_url_3", "stream_url", "stream_url_5", "stream_url_6", "stream_url_7");

  for (const key of preferred) {
    const value = String(matchPayload[key] || "").trim();
    if (isHttpUrl(value)) return value;
  }
  return "";
}

function extractManifestCandidate(html, fallbackRef) {
  const text = String(html || "");
  const relProxyMatches = text.match(/\/api\/embed-proxy\?[^"'`\s<>()]+/gi) || [];
  for (const hit of relProxyMatches) {
    const normalized = hit.replace(/&amp;/g, "&");
    if (/m3u8|manifest|playlist|chunk/i.test(normalized)) return `${BASE_URL}${normalized}`;
  }

  const absProxyMatches = text.match(/https?:\/\/[^"'`\s<>()]+\/api\/embed-proxy\?[^"'`\s<>()]+/gi) || [];
  for (const hit of absProxyMatches) {
    const normalized = hit.replace(/&amp;/g, "&");
    if (/m3u8|manifest|playlist|chunk/i.test(normalized)) return normalized;
  }

  const absM3u8Matches = text.match(/https?:\/\/[^"'`\s<>()]+\.m3u8[^"'`\s<>()]*/gi) || [];
  if (absM3u8Matches.length) return maybeProxy(absM3u8Matches[0], fallbackRef);

  return "";
}

function parseManifestLines(manifestText) {
  return String(manifestText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolveManifestLine(line, manifestUrl) {
  if (!line) return "";
  if (line.startsWith("/api/embed-proxy?")) return `${BASE_URL}${line}`;
  const abs = toAbsolute(line, manifestUrl);
  if (!abs) return "";
  if (abs.includes("/api/embed-proxy?")) return abs;
  return maybeProxy(abs, manifestUrl);
}

function getMatchPayload() {
  const apiUrl = `${BASE_URL}/api/match/${encodeURIComponent(MATCH_ID)}`;
  const res = http.get(apiUrl, {
    timeout: REQUEST_TIMEOUT,
    headers: buildHeaders(`${BASE_URL}${WATCH_PATH}`),
    tags: { type: "match_meta" },
  });
  const ok = check(res, {
    "match api status 200": (r) => r.status === 200,
    "match api has body": (r) => !!r.body,
  });
  playbackErrors.add(!ok);
  if (!ok) return null;

  try {
    const parsed = JSON.parse(String(res.body || "{}"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    playbackErrors.add(1);
    return null;
  }
  return null;
}

function fetchManifest(manifestUrl, referrer, tagSuffix = "root") {
  const res = http.get(manifestUrl, {
    timeout: REQUEST_TIMEOUT,
    headers: buildHeaders(referrer),
    tags: { type: `manifest_${tagSuffix}` },
  });
  manifestFetches.add(1);
  manifestLatency.add(res.timings.duration);
  const ok = check(res, {
    "manifest status ok": (r) => r.status >= 200 && r.status < 400,
    "manifest has extm3u": (r) => String(r.body || "").includes("#EXTM3U"),
  });
  playbackErrors.add(!ok);
  if (!ok) return null;
  return res;
}

function fetchSegment(segmentUrl, referrer) {
  const res = http.get(segmentUrl, {
    timeout: REQUEST_TIMEOUT,
    headers: buildHeaders(referrer),
    responseType: "none",
    tags: { type: "segment" },
  });
  segmentFetches.add(1);
  segmentLatency.add(res.timings.duration);
  const ok = check(res, {
    "segment status ok": (r) => r.status === 200 || r.status === 206,
  });
  playbackErrors.add(!ok);
  return ok;
}

export default function () {
  let manifestUrl = MANIFEST_URL ? maybeProxy(MANIFEST_URL, `${BASE_URL}${WATCH_PATH}`) : "";
  let sourceUrl = "";

  if (!manifestUrl) {
    const match = getMatchPayload();
    if (!match) {
      sleep(LOOP_SLEEP_SEC);
      return;
    }
    sourceUrl = pickSourceUrl(match);
    if (!sourceUrl) {
      playbackErrors.add(1);
      sleep(LOOP_SLEEP_SEC);
      return;
    }

    if (/\.m3u8(?:[?#]|$)/i.test(sourceUrl)) {
      manifestUrl = maybeProxy(sourceUrl, `${BASE_URL}${WATCH_PATH}`);
    } else {
      const proxyPageUrl = maybeProxy(sourceUrl, `${BASE_URL}${WATCH_PATH}`);
      const proxyPage = http.get(proxyPageUrl, {
        timeout: REQUEST_TIMEOUT,
        headers: buildHeaders(`${BASE_URL}${WATCH_PATH}`),
        tags: { type: "proxy_html" },
      });
      const pageOk = check(proxyPage, {
        "proxy page status ok": (r) => r.status >= 200 && r.status < 400,
      });
      playbackErrors.add(!pageOk);
      if (!pageOk) {
        sleep(LOOP_SLEEP_SEC);
        return;
      }
      manifestUrl = extractManifestCandidate(proxyPage.body, proxyPageUrl);
    }
  }

  if (!manifestUrl) {
    playbackErrors.add(1);
    sleep(LOOP_SLEEP_SEC);
    return;
  }

  const rootManifest = fetchManifest(manifestUrl, `${BASE_URL}${WATCH_PATH}`, "root");
  if (!rootManifest) {
    sleep(LOOP_SLEEP_SEC);
    return;
  }

  let mediaManifestUrl = manifestUrl;
  let mediaManifestText = String(rootManifest.body || "");
  const rootLines = parseManifestLines(mediaManifestText);
  const childPlaylist = rootLines.find((line) => /\.m3u8(?:[?#]|$)/i.test(line));
  if (childPlaylist) {
    const childUrl = resolveManifestLine(childPlaylist, manifestUrl);
    if (childUrl) {
      const childManifest = fetchManifest(childUrl, manifestUrl, "child");
      if (childManifest) {
        mediaManifestUrl = childUrl;
        mediaManifestText = String(childManifest.body || "");
      }
    }
  }

  const mediaLines = parseManifestLines(mediaManifestText);
  const segments = mediaLines.filter((line) => !/\.m3u8(?:[?#]|$)/i.test(line)).slice(0, SEGMENTS_PER_LOOP);
  if (!segments.length) {
    playbackErrors.add(1);
    sleep(LOOP_SLEEP_SEC);
    return;
  }

  for (const segment of segments) {
    const segmentUrl = resolveManifestLine(segment, mediaManifestUrl);
    if (!segmentUrl) {
      playbackErrors.add(1);
      continue;
    }
    fetchSegment(segmentUrl, mediaManifestUrl);
  }

  sleep(LOOP_SLEEP_SEC);
}

export function handleSummary(data) {
  const lines = [];
  lines.push("=== k6 live stream summary ===");
  lines.push(`base_url=${BASE_URL}`);
  lines.push(`match_id=${MATCH_ID}`);
  lines.push(`server=${SERVER}`);
  lines.push(`segments_per_loop=${SEGMENTS_PER_LOOP}`);
  lines.push(`http_req_failed=${(data.metrics.http_req_failed?.values?.rate ?? 0).toFixed(4)}`);
  lines.push(`playback_errors=${(data.metrics.playback_errors?.values?.rate ?? 0).toFixed(4)}`);
  lines.push(`http_req_duration_p95_ms=${Math.round(data.metrics.http_req_duration?.values?.["p(95)"] ?? 0)}`);
  lines.push(`manifest_latency_p95_ms=${Math.round(data.metrics.manifest_latency_ms?.values?.["p(95)"] ?? 0)}`);
  lines.push(`segment_latency_p95_ms=${Math.round(data.metrics.segment_latency_ms?.values?.["p(95)"] ?? 0)}`);
  lines.push(`manifest_fetches=${Math.round(data.metrics.manifest_fetches?.values?.count ?? 0)}`);
  lines.push(`segment_fetches=${Math.round(data.metrics.segment_fetches?.values?.count ?? 0)}`);
  const stdout = `${lines.join("\n")}\n`;
  return { stdout };
}

if (!MATCH_ID && !MANIFEST_URL && !SOURCE_URL) {
  fail("Set MATCH_ID or MANIFEST_URL or SOURCE_URL.");
}
