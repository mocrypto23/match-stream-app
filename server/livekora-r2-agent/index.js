#!/usr/bin/env node
"use strict";

const http = require("http");
const path = require("path");
const { createHash } = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("redis");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const DEFAULT_MANIFEST_CACHE_CONTROL = "no-store, no-cache, must-revalidate, max-age=0";
const DEFAULT_SEGMENT_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, immutable";
const DEFAULT_KEY_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const VALID_PROVIDER_IDS = new Set(["livekora", "beinlive", "siiir"]);

function nowIso() {
  return new Date().toISOString();
}

function toInt(raw, fallback, min = Number.MIN_SAFE_INTEGER) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function clampProgress(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isHttpUrl(raw) {
  try {
    const parsed = new URL(String(raw || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHeaderValue(raw) {
  return String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function hashHex(value) {
  return createHash("sha1").update(String(value || "")).digest("hex");
}

function hasProviderMatch(status) {
  return !!String(status?.sourceUrl || status?.currentSource || status?.playlistUrl || "").trim();
}

function buildWatchStateEventFingerprint(status) {
  return [
    status.provider,
    status.state,
    status.sourceUrl || "",
    status.currentSource || "",
    status.playlistUrl || "",
    hasProviderMatch(status) ? "1" : "0",
  ].join("::");
}

function resolveManifestUrl(raw, baseUrl) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return isHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
  }
}

function inferContentTypeFromName(name, fallback = "application/octet-stream") {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl; charset=utf-8";
  if (lower.endsWith(".ts")) return "video/mp2t";
  if (lower.endsWith(".m4s")) return "video/iso.segment";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ac3")) return "audio/ac3";
  if (lower.endsWith(".ec3")) return "audio/eac3";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".vtt")) return "text/vtt; charset=utf-8";
  if (lower.endsWith(".key")) return "application/octet-stream";
  return fallback;
}

function looksLikeNonStreamAssetPath(pathname) {
  return /\.(?:css|js|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|json|xml|txt|pdf)(?:$|[?#])/i.test(
    String(pathname || "").toLowerCase()
  );
}

function isLikelyChildPlaylistUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const pathname = String(parsed.pathname || "").toLowerCase();
    const search = String(parsed.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (looksLikeNonStreamAssetPath(pathname)) return false;
    if (/\.(?:ts|m4s|m4a|mp4|aac|mp3|vtt)(?:$|[?#])/i.test(pathname)) return false;
    if (combined.includes(".m3u8")) return true;
    if (
      pathname.includes("/hls/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/")
    ) {
      return true;
    }
    return search.includes("playlist") || search.includes("m3u8");
  } catch {
    return false;
  }
}

function looksLikeManifestResponse(contentType, body, finalUrl) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  if (/^\s*#extm3u/im.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return isLikelyChildPlaylistUrl(finalUrl);
}

function parseTargetDurationSecFromPlaylist(manifestText) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const match = trimmed.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match || !match[1]) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function parseMediaSequence(manifestText) {
  const match = String(manifestText || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  if (!match || !match[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function hasMediaSegments(manifestText, baseUrl) {
  let previousExtInf = false;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      previousExtInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute) continue;
    if (previousExtInf) return true;
    previousExtInf = false;
  }
  return false;
}

function pickVariantManifestUrl(manifestText, baseUrl) {
  let pendingBandwidth = -1;
  const variants = [];
  let order = 0;

  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match && match[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !isLikelyChildPlaylistUrl(absolute)) {
      pendingBandwidth = -1;
      continue;
    }
    variants.push({
      url: absolute,
      bandwidth: Number.isFinite(pendingBandwidth) ? pendingBandwidth : -1,
      order,
    });
    order += 1;
    pendingBandwidth = -1;
  }

  variants.sort((left, right) => {
    if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth;
    return left.order - right.order;
  });
  return variants[0] ? variants[0].url : "";
}

function filterUnavailableSegmentsFromManifest(manifestText, missingRemoteNames) {
  const blocked = new Set(
    Array.from(missingRemoteNames || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  if (!blocked.size) return String(manifestText || "");

  const lines = String(manifestText || "").split(/\r?\n/);
  const out = [];
  let pendingSegmentTags = [];

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      if (pendingSegmentTags.length) pendingSegmentTags.push(line);
      else out.push(line);
      continue;
    }
    if (trimmed.startsWith("#EXTINF") || trimmed.startsWith("#EXT-X-BYTERANGE")) {
      pendingSegmentTags.push(line);
      continue;
    }
    if (!trimmed.startsWith("#")) {
      const remoteName = path.basename(trimmed);
      if (blocked.has(remoteName)) {
        pendingSegmentTags = [];
        continue;
      }
      if (pendingSegmentTags.length) {
        out.push(...pendingSegmentTags);
        pendingSegmentTags = [];
      }
      out.push(line);
      continue;
    }
    if (pendingSegmentTags.length && (trimmed.startsWith("#EXT-X-DISCONTINUITY") || trimmed.startsWith("#EXT-X-PROGRAM-DATE-TIME"))) {
      pendingSegmentTags.push(line);
      continue;
    }
    if (pendingSegmentTags.length) {
      out.push(...pendingSegmentTags);
      pendingSegmentTags = [];
    }
    out.push(line);
  }

  return out.join("\n");
}

function normalizeProviderId(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  return VALID_PROVIDER_IDS.has(value) ? value : "livekora";
}

function normalizePublicPathPrefix(rawValue, providerId) {
  const fallback = providerId === "beinlive" ? "beinlive" : providerId === "siiir" ? "siiir" : "livekora";
  const value = String(rawValue || fallback)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return value || fallback;
}

function isSessionManifestPathname(pathname) {
  return /\/api\/[^/]+\/session-manifest$/i.test(String(pathname || "").toLowerCase());
}

function isSessionManifestUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return false;
  try {
    return isSessionManifestPathname(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

function isSessionAssetUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return false;
  try {
    return String(new URL(rawUrl).pathname || "").toLowerCase().includes("/session-asset");
  } catch {
    return false;
  }
}

function manifestUsesOnlySessionAssets(manifestText, baseUrl) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const matches = [...trimmed.matchAll(/URI="([^"]+)"/gi)];
      for (const match of matches) {
        const rawUri = match && match[1] ? String(match[1]).trim() : "";
        const absolute = resolveManifestUrl(rawUri, baseUrl);
        if (!absolute || !isSessionAssetUrl(absolute)) return false;
      }
      continue;
    }
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !isSessionAssetUrl(absolute)) return false;
  }
  return true;
}

function shouldDeleteRemoteName(name) {
  const lower = String(name || "").toLowerCase();
  return (
    lower === "index.m3u8" ||
    lower.startsWith("seg-") ||
    lower.startsWith("key-") ||
    lower.startsWith("map-") ||
    lower.startsWith("asset-")
  );
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function mapLimit(items, limit, handler) {
  const safeLimit = Math.max(1, limit);
  const out = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      out[current] = await handler(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

class LivekoraJob {
  constructor(manager, input) {
    this.manager = manager;
    this.providerId = normalizeProviderId(input.providerId);
    this.publicPathPrefix = normalizePublicPathPrefix(input.publicPathPrefix, this.providerId);
    this.matchId = input.matchId;
    this.sourceUrl = input.sourceUrl;
    this.ingestUrl = input.ingestUrl;
    this.remotePrefix = `${this.manager.config.remoteRoot}/${this.publicPathPrefix}/m${this.matchId}`;
    this.state = "starting";
    this.createdAt = Date.now();
    this.lastTouchedAt = Date.now();
    this.lastPublishAt = 0;
    this.lastError = "";
    this.lastErrorAt = 0;
    this.lastObservedTargetDurationSec = 0;
    this.lastRuntimeMediaSequence = null;
    this.lastCurrentSource = "";
    this.lastDiscoveryTiming = "";
    this.lastPlaylistFingerprint = "";
    this.consecutiveFailures = 0;
    this.phase = "queued";
    this.progressPct = 0;
    this.assetsBySourceUrl = new Map();
    this.syncTimer = null;
    this.syncPromise = null;
    this.lastPublishedEventFingerprint = "";
  }

  get playlistKey() {
    return `${this.remotePrefix}/index.m3u8`;
  }

  get publicPlaylistUrl() {
    return `${this.manager.config.publicBaseUrl}/${this.publicPathPrefix}/m${this.matchId}/index.m3u8`;
  }

  touch() {
    this.lastTouchedAt = Date.now();
  }

  setProgress(phase, progressPct) {
    this.phase = String(phase || "").trim() || this.phase || "queued";
    this.progressPct = clampProgress(progressPct, this.progressPct);
    this.touch();
    this.emitStatusEventIfChanged();
  }

  start() {
    this.touch();
    this.state = "running";
    this.setProgress("queued", 5);
    this.scheduleNextSync(0);
    this.emitStatusEventIfChanged();
  }

  async stop() {
    this.state = "stopped";
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.emitStatusEventIfChanged();
    if (this.manager.config.purgeOnStop) {
      await this.manager.purgeRemotePrefix(this.remotePrefix, this.manager.config.purgeStopMaxKeys);
    }
  }

  updateSeed(input) {
    this.sourceUrl = input.sourceUrl || this.sourceUrl;
    this.ingestUrl = input.ingestUrl || this.ingestUrl;
    this.touch();
    if (this.state === "degraded") {
      this.state = "running";
      this.consecutiveFailures = 0;
      this.lastError = "";
      this.setProgress("queued", 5);
    }
    this.emitStatusEventIfChanged();
  }

  scheduleNextSync(delayMs) {
    if (this.state === "stopped") return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.state === "stopped") return;
      void this.syncNow();
    }, Math.max(0, delayMs));
  }

  derivePublicStatus(nowMs = Date.now()) {
    const providerReadyGraceMs =
      this.providerId === "livekora"
        ? Math.max(this.manager.config.readyGraceMs, 120_000)
        : this.providerId === "siiir"
          ? Math.max(this.manager.config.readyGraceMs, 75_000)
          : Math.max(this.manager.config.readyGraceMs, 45_000);
    const dynamicReadyGraceMs =
      Number.isFinite(this.lastObservedTargetDurationSec) && this.lastObservedTargetDurationSec > 0
        ? Math.max(providerReadyGraceMs, Math.round(this.lastObservedTargetDurationSec * 1000 * 4 + 4000))
        : providerReadyGraceMs;
    if (this.state === "degraded") {
      return {
        state: "down",
        reason: this.lastError || "degraded",
      };
    }
    if (this.lastPublishAt && nowMs - this.lastPublishAt <= dynamicReadyGraceMs) {
      return {
        state: "ready",
        reason: "ready",
      };
    }
    if (this.state === "starting" || this.state === "running") {
      return {
        state: "warming",
        reason: this.lastError || "warming",
      };
    }
    return {
      state: "down",
      reason: this.lastError || "stopped",
    };
  }

  toStatus(nowMs = Date.now()) {
    const publicState = this.derivePublicStatus(nowMs);
    const isReady = publicState.state === "ready";
    const isFailed = publicState.state === "down";
    return {
      exists: true,
      provider: this.providerId,
      matchId: this.matchId,
      state: publicState.state,
      playlistUrl: publicState.state === "ready" ? this.publicPlaylistUrl : null,
      sourceUrl: this.sourceUrl,
      currentSource: this.lastCurrentSource || null,
      reason: publicState.reason,
      updatedAt: nowIso(),
      phase: isReady ? "ready" : isFailed ? "failed" : this.phase || "queued",
      progressPct: isReady ? 100 : isFailed ? clampProgress(this.progressPct, 0) : clampProgress(this.progressPct, 0),
    };
  }

  emitStatusEventIfChanged() {
    const status = this.toStatus();
    const fingerprint = buildWatchStateEventFingerprint(status);
    if (fingerprint === this.lastPublishedEventFingerprint) return;
    this.lastPublishedEventFingerprint = fingerprint;
    this.manager.publishWatchStateEvent({
      matchId: this.matchId,
      provider: this.providerId,
      state: status.state,
      sourceUrl: status.sourceUrl,
      currentSource: status.currentSource,
      playlistUrl: status.playlistUrl,
      providerHasMatch: hasProviderMatch(status),
      updatedAt: status.updatedAt,
    });
  }

  ensureAssetRecord(sourceUrl, kind) {
    const existing = this.assetsBySourceUrl.get(sourceUrl);
    if (existing) return existing;

    let ext = "";
    try {
      const pathname = String(new URL(sourceUrl).pathname || "");
      const match = pathname.match(/(\.[a-z0-9]{1,8})$/i);
      ext = match && match[1] ? match[1].toLowerCase() : "";
    } catch {}
    if (!ext) {
      if (kind === "segment") ext = ".ts";
      else if (kind === "key") ext = ".key";
      else if (kind === "map") ext = ".mp4";
      else ext = ".bin";
    }

    const prefix =
      kind === "segment" ? "seg" : kind === "key" ? "key" : kind === "map" ? "map" : "asset";
    const remoteName = `${prefix}-${hashHex(sourceUrl).slice(0, 24)}${ext}`;
    const record = {
      sourceUrl,
      kind,
      remoteName,
      remoteKey: `${this.remotePrefix}/${remoteName}`,
      uploadedAt: 0,
      lastSeenAt: 0,
      contentType: inferContentTypeFromName(remoteName),
    };
    this.assetsBySourceUrl.set(sourceUrl, record);
    return record;
  }

  rewriteManifestForPublic(manifestText, baseUrl) {
    const lines = String(manifestText || "").split(/\r?\n/);
    const out = [];
    const currentAssetUrls = new Set();

    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        out.push(line);
        continue;
      }
      if (trimmed.startsWith("#")) {
        let nextLine = line;
        nextLine = nextLine.replace(/URI="([^"]+)"/gi, (_match, rawUri) => {
          const absolute = resolveManifestUrl(rawUri, baseUrl);
          if (!absolute) return `URI="${rawUri}"`;
          const upper = trimmed.toUpperCase();
          const kind = upper.startsWith("#EXT-X-KEY") ? "key" : upper.startsWith("#EXT-X-MAP") ? "map" : "asset";
          const record = this.ensureAssetRecord(absolute, kind);
          currentAssetUrls.add(absolute);
          return `URI="${record.remoteName}"`;
        });
        out.push(nextLine);
        continue;
      }

      const absolute = resolveManifestUrl(trimmed, baseUrl);
      if (!absolute) {
        out.push(line);
        continue;
      }
      const record = this.ensureAssetRecord(absolute, "segment");
      currentAssetUrls.add(absolute);
      out.push(record.remoteName);
    }

    return {
      manifestBody: out.join("\n"),
      currentAssetUrls,
      mediaSequence: parseMediaSequence(manifestText),
      targetDurationSec: parseTargetDurationSecFromPlaylist(manifestText),
    };
  }

  async fetchManifestDocument(options = {}) {
    this.setProgress(options.forceRefresh ? "resolving_source" : "fetching_manifest", options.forceRefresh ? 18 : 14);
    const computeManifestFetchTimeoutMs = (rawUrl) => {
      const defaultTimeoutMs = this.manager.config.manifestFetchTimeoutMs;
      if (!isSessionManifestUrl(rawUrl)) return defaultTimeoutMs;
      const isColdBootstrap = !this.lastPublishAt && !this.lastCurrentSource;
      if (this.providerId === "livekora") {
        return Math.max(defaultTimeoutMs, isColdBootstrap ? 95_000 : 65_000);
      }
      if (this.providerId === "siiir") {
        return Math.max(defaultTimeoutMs, isColdBootstrap ? 50_000 : 40_000);
      }
      if (this.providerId === "beinlive") {
        return Math.max(defaultTimeoutMs, isColdBootstrap ? 35_000 : 25_000);
      }
      return defaultTimeoutMs;
    };
    const buildFetchUrl = (rawUrl, fetchOptions = {}) => {
      if (!isSessionManifestUrl(rawUrl)) return rawUrl;
      try {
        const parsed = new URL(rawUrl);
        if (
          !fetchOptions.skipWaitForMediaSequence &&
          Number.isFinite(this.lastRuntimeMediaSequence) &&
          this.lastRuntimeMediaSequence !== null
        ) {
          parsed.searchParams.set("waitForMediaSequence", String(this.lastRuntimeMediaSequence));
          parsed.searchParams.set(
            "waitTimeoutMs",
            String(
              Math.max(
                1500,
                Math.min(
                  this.manager.config.manifestFetchTimeoutMs,
                  Math.round(Math.max(2, this.lastObservedTargetDurationSec || 2) * 1000 * 1.2)
                )
              )
            )
          );
        }
        parsed.searchParams.set("allowRotate", "1");
        if (options.forceRefresh) {
          parsed.searchParams.set("forceRefresh", "1");
        }
        return parsed.toString();
      } catch {
        return rawUrl;
      }
    };

    const fetchOnce = async (rawUrl, fetchOptions = {}) => {
      const requestUrl = buildFetchUrl(rawUrl, fetchOptions);
      const requestTimeoutMs = computeManifestFetchTimeoutMs(requestUrl);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(requestUrl, {
          method: "GET",
          cache: "no-store",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
            "user-agent": DEFAULT_USER_AGENT,
            "x-livekora-r2-agent": "1",
          },
        });
        const body = await response.text();
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        const finalUrl = response.url || requestUrl;
        if (!response.ok) {
          return {
            ok: false,
            reason: `manifest-http-${response.status || 0}`,
            body,
            contentType,
            finalUrl,
          };
        }
        if (isSessionManifestUrl(requestUrl)) {
          const genericSessionHeader = String(response.headers.get("x-r2-session-manifest") || "").trim();
          const legacySessionHeader = String(response.headers.get("x-livekora-session-manifest") || "").trim();
          if (genericSessionHeader !== "1" && legacySessionHeader !== "1") {
            return {
              ok: false,
              reason: "session-manifest-missing-header",
              body,
              contentType,
              finalUrl,
            };
          }
        }
        if (!looksLikeManifestResponse(contentType, body, finalUrl)) {
          return {
            ok: false,
            reason: "manifest-not-hls",
            body,
            contentType,
            finalUrl,
          };
        }
        if (isSessionManifestUrl(requestUrl) && !manifestUsesOnlySessionAssets(body, finalUrl)) {
          return {
            ok: false,
            reason: "session-manifest-non-session-assets",
            body,
            contentType,
            finalUrl,
          };
        }
        return {
          ok: true,
          body,
          contentType,
          finalUrl,
          runtimeMediaSequence: Number.parseInt(
            String(response.headers.get("x-r2-media-sequence") || response.headers.get("x-livekora-media-sequence") || "").trim(),
            10
          ),
          runtimeTargetDurationSec: Number.parseFloat(
            String(response.headers.get("x-r2-target-duration") || response.headers.get("x-livekora-target-duration") || "").trim()
          ),
          currentSource: normalizeHeaderValue(response.headers.get("x-r2-current-source") || response.headers.get("x-livekora-current-source")),
          discoveryTiming: normalizeHeaderValue(
            response.headers.get("x-r2-discovery-timing") || response.headers.get("x-livekora-discovery-timing")
          ),
        };
      } catch (error) {
        return {
          ok: false,
          reason: `manifest-fetch-failed:${error instanceof Error ? error.message : String(error)}`,
          body: "",
          contentType: "",
          finalUrl: requestUrl,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let currentUrl = this.ingestUrl;
    for (let depth = 0; depth < 3; depth += 1) {
      let fetched = await fetchOnce(currentUrl);
      if (
        !fetched.ok &&
        isSessionManifestUrl(currentUrl) &&
        /manifest-fetch-failed:.*aborted/i.test(String(fetched.reason || ""))
      ) {
        this.manager.log("warn", "retrying manifest fetch without media-sequence wait", {
          matchId: this.matchId,
          provider: this.providerId,
          currentSource: this.lastCurrentSource,
        });
        fetched = await fetchOnce(currentUrl, { skipWaitForMediaSequence: true });
      }
      if (!fetched.ok) return fetched;
      if (Number.isFinite(fetched.runtimeTargetDurationSec) && fetched.runtimeTargetDurationSec > 0) {
        this.lastObservedTargetDurationSec = fetched.runtimeTargetDurationSec;
      }
      if (Number.isFinite(fetched.runtimeMediaSequence)) {
        this.lastRuntimeMediaSequence = fetched.runtimeMediaSequence;
      }
      if (fetched.currentSource) {
        this.lastCurrentSource = fetched.currentSource;
      }
      if (fetched.discoveryTiming && fetched.discoveryTiming !== this.lastDiscoveryTiming) {
        this.lastDiscoveryTiming = fetched.discoveryTiming;
        this.manager.log("info", "session-manifest discovery timing", {
          matchId: this.matchId,
          provider: this.providerId,
          timing: fetched.discoveryTiming,
          currentSource: this.lastCurrentSource || null,
        });
      }
      if (hasMediaSegments(fetched.body, fetched.finalUrl)) return fetched;

      const variantUrl = pickVariantManifestUrl(fetched.body, fetched.finalUrl);
      if (!variantUrl) {
        this.manager.log("warn", "livekora manifest missing media playlist", {
          matchId: this.matchId,
          requestUrl: currentUrl,
          finalUrl: fetched.finalUrl,
          contentType: fetched.contentType,
          bodyLength: String(fetched.body || "").length,
          bodySnippet: String(fetched.body || "")
            .split(/\r?\n/)
            .slice(0, 12)
            .join("\n"),
        });
        return {
          ok: false,
          reason: "manifest-no-media-playlist",
          body: fetched.body,
          contentType: fetched.contentType,
          finalUrl: fetched.finalUrl,
        };
      }
      this.setProgress("resolving_variant", 35);
      currentUrl = variantUrl;
    }

    return {
      ok: false,
      reason: "manifest-recursion-limit",
      body: "",
      contentType: "",
      finalUrl: this.ingestUrl,
    };
  }

  async uploadAsset(record) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.manager.config.assetFetchTimeoutMs);
    try {
      if (!isSessionAssetUrl(record.sourceUrl)) {
        throw new Error("session-asset-url-required");
      }
      const response = await fetch(record.sourceUrl, {
        method: "GET",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          "x-livekora-r2-agent": "1",
        },
      });
      if (!response.ok) {
        throw new Error(`asset-http-${response.status || 0}`);
      }
      if (
        String(response.headers.get("x-r2-session-asset") || "").trim() !== "1" &&
        String(response.headers.get("x-livekora-session-asset") || "").trim() !== "1"
      ) {
        throw new Error("session-asset-missing-header");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType =
        normalizeHeaderValue(response.headers.get("content-type")) || inferContentTypeFromName(record.remoteName);
      await this.manager.r2.send(
        new PutObjectCommand({
          Bucket: this.manager.config.r2Bucket,
          Key: record.remoteKey,
          Body: bytes,
          ContentType: contentType,
          CacheControl: record.kind === "segment" ? DEFAULT_SEGMENT_CACHE_CONTROL : DEFAULT_KEY_CACHE_CONTROL,
        })
      );
      record.uploadedAt = Date.now();
      record.contentType = contentType;
      return { ok: true };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async cleanupStaleAssets(nowMs, currentAssetUrls) {
    const staleSources = [];
    for (const [sourceUrl, record] of this.assetsBySourceUrl.entries()) {
      if (currentAssetUrls.has(sourceUrl)) continue;
      if (nowMs - record.lastSeenAt <= this.manager.config.remoteRetentionMs) continue;
      staleSources.push(sourceUrl);
    }
    if (!staleSources.length) return;

    await mapLimit(staleSources, this.manager.config.mirrorAssetConcurrency, async (sourceUrl) => {
      const record = this.assetsBySourceUrl.get(sourceUrl);
      if (!record) return;
      try {
        await this.manager.r2.send(
          new DeleteObjectCommand({
            Bucket: this.manager.config.r2Bucket,
            Key: record.remoteKey,
          })
        );
      } catch {}
      this.assetsBySourceUrl.delete(sourceUrl);
    });
  }

  async uploadManifest(manifestBody) {
    await this.manager.r2.send(
      new PutObjectCommand({
        Bucket: this.manager.config.r2Bucket,
        Key: this.playlistKey,
        Body: manifestBody,
        ContentType: "application/vnd.apple.mpegurl; charset=utf-8",
        CacheControl: DEFAULT_MANIFEST_CACHE_CONTROL,
      })
    );
    this.lastPublishAt = Date.now();
  }

  async performSync() {
    try {
      this.setProgress("resolving_source", 8);
      for (let syncAttempt = 0; syncAttempt < 2; syncAttempt += 1) {
        const manifest = await this.fetchManifestDocument({ forceRefresh: syncAttempt > 0 });
        if (!manifest.ok) {
          this.lastError = manifest.reason;
          this.lastErrorAt = Date.now();
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= this.manager.config.maxConsecutiveFailures) {
            this.state = "degraded";
            this.setProgress("failed", this.progressPct);
          }
          return {
            ok: false,
            reason: manifest.reason,
            nextDelayMs: Math.max(1000, this.manager.config.uploadPollMs),
          };
        }

        const rewritten = this.rewriteManifestForPublic(manifest.body, manifest.finalUrl);
        const nowMs = Date.now();
        this.touch();
        if (Number.isFinite(rewritten.targetDurationSec) && rewritten.targetDurationSec > 0) {
          this.lastObservedTargetDurationSec = rewritten.targetDurationSec;
        }
        if (Number.isFinite(rewritten.mediaSequence)) {
          this.lastRuntimeMediaSequence = rewritten.mediaSequence;
        }

        const uploads = [];
        for (const sourceUrl of rewritten.currentAssetUrls) {
          const record = this.assetsBySourceUrl.get(sourceUrl);
          if (!record) continue;
          record.lastSeenAt = nowMs;
          if (record.uploadedAt > 0) continue;
          uploads.push(record);
        }

        this.setProgress("mirroring_assets", uploads.length ? 52 : 86);
        const failedUploads = [];
        let completedUploads = 0;
        const updateMirroringProgress = () => {
          if (!uploads.length) {
            this.setProgress("mirroring_assets", 86);
            return;
          }
          const nextProgress = 52 + Math.round((completedUploads / uploads.length) * 36);
          this.setProgress("mirroring_assets", nextProgress);
        };
        await mapLimit(uploads, this.manager.config.mirrorAssetConcurrency, async (record) => {
          try {
            await this.uploadAsset(record);
          } catch (error) {
            failedUploads.push({ record, error: error instanceof Error ? error.message : String(error) });
          } finally {
            completedUploads += 1;
            updateMirroringProgress();
          }
        });

        const fatalUpload = failedUploads.find(({ record }) => record.kind !== "segment");
        if (fatalUpload) {
          throw new Error(fatalUpload.error);
        }

        let publishManifestBody = rewritten.manifestBody;
        if (failedUploads.length) {
          const missingRemoteNames = new Set(failedUploads.map(({ record }) => record.remoteName));
          publishManifestBody = filterUnavailableSegmentsFromManifest(rewritten.manifestBody, missingRemoteNames);
          const allSegment403 =
            failedUploads.length > 0 &&
            failedUploads.every(
              ({ record, error }) => record.kind === "segment" && /asset-http-403/i.test(String(error || ""))
            );
          if (!hasMediaSegments(publishManifestBody, this.publicPlaylistUrl)) {
            if (allSegment403 && syncAttempt === 0) {
              this.setProgress("resolving_source", 32);
              this.manager.log("warn", "retrying manifest sync after segment 403", {
                matchId: this.matchId,
                provider: this.providerId,
                currentSource: this.lastCurrentSource,
              });
              continue;
            }
            throw new Error(failedUploads[0].error);
          }
        }

        await this.cleanupStaleAssets(nowMs, rewritten.currentAssetUrls);
        const fingerprint = hashHex(publishManifestBody);
        this.setProgress("publishing_playlist", 94);
        if (
          fingerprint !== this.lastPlaylistFingerprint ||
          !this.lastPublishAt ||
          nowMs - this.lastPublishAt >= this.manager.config.playlistPublishMinIntervalMs
        ) {
          await this.uploadManifest(publishManifestBody);
          this.lastPlaylistFingerprint = fingerprint;
        }

        this.state = "running";
        this.consecutiveFailures = 0;
        this.lastError = "";
        this.setProgress("ready", 100);
        const nextDelayMs = Math.max(
          600,
          Math.min(8000, Math.round(Math.max(2, this.lastObservedTargetDurationSec || 2) * 1000 * 0.45))
        );
        return { ok: true, reason: syncAttempt > 0 ? "ok_after_forced_refresh" : "ok", nextDelayMs };
      }

      throw new Error("segment-refresh-retry-exhausted");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastErrorAt = Date.now();
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.manager.config.maxConsecutiveFailures) {
        this.state = "degraded";
        this.setProgress("failed", this.progressPct);
      }
      return {
        ok: false,
        reason: this.lastError,
        nextDelayMs: Math.max(1000, this.manager.config.uploadPollMs),
      };
    }
  }

  async syncNow() {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync()
      .catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        nextDelayMs: this.manager.config.uploadPollMs,
      }))
      .then((result) => {
        if (this.state !== "stopped") {
          this.scheduleNextSync(result.nextDelayMs);
        }
        return result;
      })
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
  }
}

class LivekoraManager {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.redisPub = null;
    this.redisPubReady = false;
    this.r2 = new S3Client({
      region: "auto",
      endpoint: config.r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    });
  }

  async ensureRedisPublisher() {
    if (!this.config.watchStateRedisUrl) return null;
    if (this.redisPubReady && this.redisPub) return this.redisPub;
    if (!this.redisPub) {
      this.redisPub = createClient({ url: this.config.watchStateRedisUrl });
      this.redisPub.on("error", (error) => {
        this.redisPubReady = false;
        this.log("warn", "watch-state redis publisher error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (!this.redisPubReady) {
      await this.redisPub.connect();
      this.redisPubReady = true;
      this.log("info", "watch-state redis publisher connected", {
        redisUrl: this.config.watchStateRedisUrl,
      });
    }
    return this.redisPub;
  }

  publishWatchStateEvent(payload) {
    if (!this.config.watchStateRedisUrl) return;
    const matchId = Number.parseInt(String(payload?.matchId || "").trim(), 10);
    if (!Number.isFinite(matchId) || matchId <= 0) return;
    const channel = `watch-state:match:${matchId}`;
    const body = JSON.stringify({
      type: "watch-state-change",
      ...payload,
      ts: nowIso(),
    });
    void this.ensureRedisPublisher()
      .then((client) => (client ? client.publish(channel, body) : null))
      .catch((error) => {
        this.redisPubReady = false;
        this.log("warn", "watch-state event publish failed", {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  log(level, message, extra = {}) {
    process.stdout.write(`${JSON.stringify({ ts: nowIso(), level, message, ...extra })}\n`);
  }

  buildJobKey(providerId, matchId) {
    return `${normalizeProviderId(providerId)}:${String(matchId)}`;
  }

  getJob(providerId, matchId) {
    return this.jobs.get(this.buildJobKey(providerId, matchId)) || null;
  }

  async stopJob(providerId, matchId) {
    const key = this.buildJobKey(providerId, matchId);
    const job = this.jobs.get(key);
    if (!job) return;
    await job.stop();
    this.jobs.delete(key);
  }

  async purgeRemotePrefix(prefix, maxKeys) {
    const safePrefix = String(prefix || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!safePrefix) return;
    let continuationToken = undefined;
    let deleted = 0;
    while (deleted < maxKeys) {
      const listed = await this.r2.send(
        new ListObjectsV2Command({
          Bucket: this.config.r2Bucket,
          Prefix: `${safePrefix}/`,
          ContinuationToken: continuationToken,
          MaxKeys: Math.min(1000, maxKeys - deleted),
        })
      );
      const contents = Array.isArray(listed.Contents) ? listed.Contents : [];
      const objects = contents
        .map((item) => String(item.Key || "").trim())
        .filter(Boolean)
        .filter((key) => shouldDeleteRemoteName(path.basename(key)));
      if (objects.length) {
        await this.r2.send(
          new DeleteObjectsCommand({
            Bucket: this.config.r2Bucket,
            Delete: {
              Objects: objects.map((key) => ({ Key: key })),
              Quiet: true,
            },
          })
        );
        deleted += objects.length;
      }
      if (!listed.IsTruncated || !listed.NextContinuationToken) break;
      continuationToken = listed.NextContinuationToken;
    }
  }

  sweepIdleJobs() {
    const nowMs = Date.now();
    for (const [jobKey, job] of this.jobs.entries()) {
      if (nowMs - job.lastTouchedAt <= this.config.idleStopMs) continue;
      void this.stopJob(job.providerId, job.matchId).catch(() => {
        this.jobs.delete(jobKey);
      });
    }
  }

  async bootstrap(input) {
    if (!Number.isFinite(input.matchId) || input.matchId <= 0) {
      return { accepted: false, reason: "invalid-match-id", status: null };
    }
    const providerId = normalizeProviderId(input.providerId);
    const publicPathPrefix = normalizePublicPathPrefix(input.publicPathPrefix, providerId);
    if (!isHttpUrl(input.sourceUrl) || !isHttpUrl(input.ingestUrl)) {
      return { accepted: false, reason: "invalid-bootstrap-input", status: null };
    }

    const key = this.buildJobKey(providerId, input.matchId);
    let job = this.jobs.get(key);
    if (!job) {
      job = new LivekoraJob(this, {
        ...input,
        providerId,
        publicPathPrefix,
      });
      this.jobs.set(key, job);
      if (this.config.purgeOnBootstrap) {
        await this.purgeRemotePrefix(job.remotePrefix, this.config.purgeStopMaxKeys);
      }
      job.start();
      this.log("info", "r2 mirror job started", {
        provider: providerId,
        matchId: input.matchId,
        sourceUrl: input.sourceUrl,
      });
    } else {
      job.updateSeed(input);
      job.scheduleNextSync(0);
    }

    if (!job.syncPromise) {
      void job.syncNow().catch((error) => {
        this.log("warn", "bootstrap sync kickoff failed", {
          provider: providerId,
          matchId: input.matchId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return {
      accepted: true,
      reason: "accepted",
      status: job.toStatus(),
    };
  }

  status(providerId, matchId) {
    const normalizedProviderId = normalizeProviderId(providerId);
    const job = this.getJob(normalizedProviderId, matchId);
    if (!job) {
      return {
        exists: false,
        provider: normalizedProviderId,
        matchId,
        state: "down",
        playlistUrl: null,
        sourceUrl: null,
        currentSource: null,
        reason: "not-bootstrapped",
        updatedAt: nowIso(),
        phase: "queued",
        progressPct: 0,
      };
    }
    return job.toStatus();
  }

  diag() {
    return {
      now: nowIso(),
      publicBaseUrl: this.config.publicBaseUrl,
      jobs: Array.from(this.jobs.values()).map((job) => ({
        provider: job.providerId,
        matchId: job.matchId,
        state: job.state,
        lastTouchedAt: job.lastTouchedAt,
        lastPublishAt: job.lastPublishAt || null,
        sourceUrl: job.sourceUrl,
        currentSource: job.lastCurrentSource || null,
        playlistUrl: job.publicPlaylistUrl,
        lastError: job.lastError || null,
        phase: job.phase || null,
        progressPct: job.progressPct,
      })),
    };
  }
}

function loadConfig() {
  const r2Endpoint = String(process.env.R2_ENDPOINT || "").trim();
  const r2Bucket = String(process.env.R2_BUCKET || "").trim();
  const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
  const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const publicBaseUrl = String(process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
    .trim()
    .replace(/\/+$/, "");

  if (!r2Endpoint || !r2Bucket || !r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("Missing R2 configuration (endpoint/bucket/access key/secret).");
  }

  return {
    bind: String(process.env.LIVEKORA_R2_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1",
    port: toInt(process.env.LIVEKORA_R2_AGENT_PORT, 3500, 1),
    r2Endpoint,
    r2Bucket,
    r2AccessKeyId,
    r2SecretAccessKey,
    publicBaseUrl,
    remoteRoot: String(process.env.LIVEKORA_R2_REMOTE_ROOT || "live").trim().replace(/^\/+|\/+$/g, "") || "live",
    idleStopMs: toInt(process.env.LIVEKORA_R2_IDLE_STOP_MS, 30 * 60 * 1000, 60_000),
    uploadPollMs: toInt(process.env.LIVEKORA_R2_UPLOAD_POLL_MS, 2200, 400),
    playlistPublishMinIntervalMs: toInt(process.env.LIVEKORA_R2_PLAYLIST_PUBLISH_MIN_INTERVAL_MS, 4000, 1000),
    manifestFetchTimeoutMs: toInt(process.env.LIVEKORA_R2_MANIFEST_FETCH_TIMEOUT_MS, 15_000, 2000),
    readyGraceMs: toInt(process.env.LIVEKORA_R2_READY_GRACE_MS, 45_000, 10_000),
    assetFetchTimeoutMs: toInt(process.env.LIVEKORA_R2_ASSET_FETCH_TIMEOUT_MS, 22_000, 3000),
    mirrorAssetConcurrency: toInt(process.env.LIVEKORA_R2_ASSET_CONCURRENCY, 6, 1),
    remoteRetentionMs: toInt(process.env.LIVEKORA_R2_REMOTE_RETENTION_MS, 45_000, 5000),
    maxConsecutiveFailures: toInt(process.env.LIVEKORA_R2_MAX_CONSECUTIVE_FAILURES, 6, 1),
    purgeStopMaxKeys: toInt(process.env.LIVEKORA_R2_PURGE_MAX_KEYS, 5000, 100),
    purgeOnBootstrap: String(process.env.LIVEKORA_R2_PURGE_ON_BOOTSTRAP || "").trim() === "1",
    purgeOnStop: String(process.env.LIVEKORA_R2_PURGE_ON_STOP || "").trim() === "1",
    watchStateRedisUrl:
      String(process.env.WATCH_STATE_REDIS_URL || "redis://127.0.0.1:6379").trim() || "redis://127.0.0.1:6379",
  };
}

async function main() {
  const config = loadConfig();
  const manager = new LivekoraManager(config);

  const server = http.createServer(async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const parsed = new URL(req.url || "/", `http://${config.bind}:${config.port}`);

    try {
      if (method === "GET" && parsed.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, ts: nowIso() });
      }
      if (method === "GET" && parsed.pathname === "/diag") {
        return sendJson(res, 200, manager.diag());
      }
      if (method === "GET" && parsed.pathname === "/status") {
        const matchId = Number.parseInt(String(parsed.searchParams.get("matchId") || "").trim(), 10);
        const providerId = normalizeProviderId(parsed.searchParams.get("providerId"));
        return sendJson(res, 200, manager.status(providerId, matchId));
      }
      if (method === "GET" && parsed.pathname === "/status-all") {
        const matchId = Number.parseInt(String(parsed.searchParams.get("matchId") || "").trim(), 10);
        return sendJson(res, 200, {
          livekora: manager.status("livekora", matchId),
          beinlive: manager.status("beinlive", matchId),
          siiir: manager.status("siiir", matchId),
          updatedAt: nowIso(),
        });
      }
      if (method === "POST" && parsed.pathname === "/bootstrap") {
        const payload = await readJsonBody(req);
        const result = await manager.bootstrap(payload || {});
        return sendJson(res, result.accepted ? 200 : 400, result);
      }
      return sendJson(res, 404, { error: "not-found" });
    } catch (error) {
      return sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  setInterval(() => {
    manager.sweepIdleJobs();
  }, 10_000).unref();

  server.listen(config.port, config.bind, () => {
    manager.log("info", "livekora-r2-agent started", {
      bind: config.bind,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      remoteRoot: config.remoteRoot,
      bucket: config.r2Bucket,
    });
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[livekora-r2-agent] fatal: ${message}\n`);
  process.exit(1);
});
