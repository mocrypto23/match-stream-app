#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const http = require("http");
const path = require("path");
const { createHash } = require("crypto");
const dotenv = require("dotenv");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const DEFAULT_MANIFEST_CACHE_CONTROL = "no-store, no-cache, must-revalidate, max-age=0";
const DEFAULT_SEGMENT_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, immutable";
const DEFAULT_KEY_CACHE_CONTROL = "public, max-age=60, s-maxage=300";

function nowIso() {
  return new Date().toISOString();
}

function toInt(raw, fallback, min = Number.MIN_SAFE_INTEGER) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function toBool(raw, fallback = false) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseMatchStartMs(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function computeMatchWindowState(matchStartMs, config, nowMs = Date.now()) {
  const startAtMs = Number.isFinite(matchStartMs) ? Number(matchStartMs) : null;
  if (!startAtMs) {
    return {
      hasStart: false,
      startAtMs: null,
      openAtMs: null,
      closeAtMs: null,
      inWindow: false,
    };
  }
  const openAtMs = startAtMs - config.prematchOpenWindowMs;
  const closeAtMs = startAtMs + config.matchDurationMs + config.postmatchGraceMs;
  return {
    hasStart: true,
    startAtMs,
    openAtMs,
    closeAtMs,
    inWindow: nowMs >= openAtMs && nowMs <= closeAtMs,
  };
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHeaderValue(raw) {
  const value = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return value || "";
}

function normalizeCandidateUrl(raw, playerOrigin) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (isHttpUrl(value)) return value;
  if (value.startsWith("/")) return `${String(playerOrigin || "").replace(/\/+$/, "")}${value}`;
  return "";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function hashHex(value) {
  return createHash("sha1").update(String(value || "")).digest("hex");
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

function looksLikeManifestResponse(contentType, body, finalUrl) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  const url = String(finalUrl || "").toLowerCase();
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return url.includes(".m3u8");
}

function parseTargetDurationSecFromPlaylist(manifestText) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const match = trimmed.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match || !match[1]) continue;
    const n = Number.parseFloat(match[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function parseMediaSequence(manifestText) {
  const match = String(manifestText || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  if (!match || !match[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
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

function looksLikeNonStreamAssetPath(pathname) {
  return /\.(?:css|js|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|json|xml|txt|pdf)(?:$|[?#])/i.test(
    String(pathname || "").toLowerCase()
  );
}

function isLikelyChildPlaylistUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (looksLikeNonStreamAssetPath(pathname)) return false;
    if (/\.(?:ts|m4s|m4a|mp4|aac|mp3|vtt)(?:$|[?#])/i.test(pathname)) return false;
    if (combined.includes(".mpd")) return false;
    if (combined.includes(".m3u8")) return true;
    if (pathname.includes("/api/embed-proxy")) {
      const target = safeDecodeURIComponent(String(u.searchParams.get("url") || "").trim());
      if (target && isLikelyChildPlaylistUrl(target)) return true;
    }
    if (
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/")
    ) {
      return true;
    }
    if (
      search.includes("token=") ||
      search.includes("session") ||
      search.includes("stream=") ||
      search.includes("playlist") ||
      search.includes("m3u8") ||
      search.includes("sid=")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
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
      if (!trimmed.startsWith("#EXT-X-STREAM-INF")) previousExtInf = false;
      continue;
    }
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute) continue;
    if (previousExtInf) return true;
    if (!isLikelyChildPlaylistUrl(absolute)) return true;
    previousExtInf = false;
  }
  return false;
}

function buildStrictGatewayIngestUrlKey(matchId, serverId) {
  return `m${matchId}:s${serverId}`;
}

function isStrictGatewayIngestUrl(rawUrl, matchId, serverId) {
  if (!isHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    if (!String(parsed.pathname || "").toLowerCase().includes("/api/repack/ingest")) return false;
    const matchParam = Number.parseInt(String(parsed.searchParams.get("matchId") || ""), 10);
    const slotParam = Number.parseInt(String(parsed.searchParams.get("slotServer") || ""), 10);
    return matchParam === matchId && slotParam === serverId;
  } catch {
    return false;
  }
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

async function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
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

class MirrorJob {
  constructor(manager, input) {
    this.manager = manager;
    this.matchId = input.matchId;
    this.serverId = input.serverId;
    this.sourceUrl = input.sourceUrl;
    this.ingestUrl = input.ingestUrl;
    this.remotePrefix = input.remotePrefix.replace(/\/+$/, "");
    this.state = "starting";
    this.createdAt = Date.now();
    this.lastSeedAt = Date.now();
    this.lastPublishAt = 0;
    this.lastErrorAt = 0;
    this.lastError = "";
    this.consecutiveSourceErrors = 0;
    this.lastObservedTargetDurationSec = 0;
    this.lastPlaylistMediaSeq = null;
    this.lastPublishedPlaylistFingerprint = "";
    this.assetsBySourceUrl = new Map();
    this.pollTimer = null;
    this.monitorTimer = null;
    this.syncPromise = null;
    this.totalPlaylistPublishes = 0;
    this.totalAssetUploads = 0;
    this.totalAssetBytes = 0;
    this.lastUploadLatencyMs = 0;
    this.lastPlaylistLatencyMs = 0;
    this.degradedReason = "";
    this.degradedAt = 0;
  }

  get key() {
    return buildStrictGatewayIngestUrlKey(this.matchId, this.serverId);
  }

  get playlistKey() {
    return `${this.remotePrefix}/index.m3u8`;
  }

  get publicPlaylistUrl() {
    return `${this.manager.config.publicBaseUrl}/m${this.matchId}/s${this.serverId}/index.m3u8`;
  }

  async start() {
    if (this.manager.config.purgeRemoteOnStart) {
      await this.manager.purgeRemotePrefix(this.remotePrefix, this.manager.config.purgeStopMaxKeys);
    }
    this.pollTimer = setInterval(() => {
      void this.syncNow("poll");
    }, this.manager.config.uploadPollMs);
    this.monitorTimer = setInterval(() => {
      void this.healthSweep();
    }, 5000);
    this.state = "running";
  }

  async stop() {
    this.state = "stopped";
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.pollTimer = null;
    this.monitorTimer = null;
    if (this.manager.config.purgeRemoteOnStop) {
      await this.manager.purgeRemotePrefix(this.remotePrefix, this.manager.config.purgeStopMaxKeys);
    }
  }

  updateSeed(input) {
    this.lastSeedAt = Date.now();
    this.sourceUrl = input.sourceUrl || this.sourceUrl;
    this.ingestUrl = input.ingestUrl || this.ingestUrl;
    if (this.state === "degraded") {
      this.state = "running";
      this.degradedReason = "";
      this.degradedAt = 0;
      this.consecutiveSourceErrors = 0;
    }
  }

  toDiag(nowMs = Date.now()) {
    return {
      key: this.key,
      matchId: this.matchId,
      serverId: this.serverId,
      state: this.state,
      sourceUrl: this.sourceUrl,
      ingestUrl: this.ingestUrl,
      ingestUrlKind: "strict_gateway",
      lastSeedAt: this.lastSeedAt,
      lastPublishAt: this.lastPublishAt || null,
      lastPublishAgeMs: this.lastPublishAt ? Math.max(0, nowMs - this.lastPublishAt) : null,
      lastObservedTargetDurationSec: this.lastObservedTargetDurationSec || null,
      consecutiveSourceErrors: this.consecutiveSourceErrors,
      degradedReason: this.degradedReason || null,
      totalPlaylistPublishes: this.totalPlaylistPublishes,
      totalAssetUploads: this.totalAssetUploads,
      totalAssetBytes: this.totalAssetBytes,
      publicPlaylistUrl: this.publicPlaylistUrl,
      lastError: this.lastError || null,
    };
  }

  async healthSweep() {
    if (this.state === "stopped") return;
    const nowMs = Date.now();
    if (nowMs - this.lastSeedAt > this.manager.config.idleStopMs) {
      await this.manager.stopJob(this.key);
    }
  }

  async syncNow(reason) {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync(reason)
      .catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
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

  async fetchManifestDocument() {
    const fetchManifestOnce = async (fetchUrl) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.manager.config.manifestFetchTimeoutMs);
      try {
        const response = await fetch(fetchUrl, {
          method: "GET",
          cache: "no-store",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
            "user-agent": DEFAULT_USER_AGENT,
          },
        });
        const body = await response.text();
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        const finalUrl = response.url || fetchUrl;
        if (!response.ok) {
          return {
            ok: false,
            reason: `manifest-http-${response.status || 0}`,
            body,
            contentType,
            finalUrl,
          };
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
        return {
          ok: true,
          body,
          contentType,
          finalUrl,
        };
      } catch (error) {
        return {
          ok: false,
          reason: `manifest-fetch-failed:${error instanceof Error ? error.message : String(error)}`,
          body: "",
          contentType: "",
          finalUrl: fetchUrl,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let currentUrl = this.ingestUrl;
    for (let depth = 0; depth < 3; depth += 1) {
      const fetched = await fetchManifestOnce(currentUrl);
      if (!fetched.ok) return fetched;
      if (hasMediaSegments(fetched.body, fetched.finalUrl)) return fetched;

      const variantUrl = pickVariantManifestUrl(fetched.body, fetched.finalUrl);
      if (!variantUrl) {
        return {
          ok: false,
          reason: "manifest-no-media-playlist",
          body: fetched.body,
          contentType: fetched.contentType,
          finalUrl: fetched.finalUrl,
        };
      }
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
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.manager.config.assetFetchTimeoutMs);
    try {
      const response = await fetch(record.sourceUrl, {
        method: "GET",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
        },
      });
      if (!response.ok) {
        throw new Error(`asset-http-${response.status || 0}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType =
        normalizeHeaderValue(response.headers.get("content-type")) || inferContentTypeFromName(record.remoteName);
      const cacheControl = record.kind === "segment" ? DEFAULT_SEGMENT_CACHE_CONTROL : DEFAULT_KEY_CACHE_CONTROL;
      await this.manager.r2.send(
        new PutObjectCommand({
          Bucket: this.manager.config.r2Bucket,
          Key: record.remoteKey,
          Body: bytes,
          ContentType: contentType,
          CacheControl: cacheControl,
        })
      );
      record.uploadedAt = Date.now();
      record.contentType = contentType;
      this.totalAssetUploads += 1;
      this.totalAssetBytes += bytes.length;
      this.lastUploadLatencyMs = Date.now() - startedAt;
      return { ok: true };
    } catch (error) {
      this.manager.metrics.uploadErrors += 1;
      throw error;
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
    const startedAt = Date.now();
    await this.manager.r2.send(
      new PutObjectCommand({
        Bucket: this.manager.config.r2Bucket,
        Key: this.playlistKey,
        Body: manifestBody,
        ContentType: "application/vnd.apple.mpegurl; charset=utf-8",
        CacheControl: DEFAULT_MANIFEST_CACHE_CONTROL,
      })
    );
    this.lastPlaylistLatencyMs = Date.now() - startedAt;
    this.lastPublishAt = Date.now();
    this.totalPlaylistPublishes += 1;
  }

  async performSync(reason) {
    if (this.state === "stopped") return { ok: false, reason: "job-stopped" };

    const manifest = await this.fetchManifestDocument();
    if (!manifest.ok) {
      this.lastErrorAt = Date.now();
      this.lastError = manifest.reason;
      this.consecutiveSourceErrors += 1;
      if (this.consecutiveSourceErrors >= this.manager.config.maxConsecutiveFailures) {
        this.state = "degraded";
        this.degradedReason = manifest.reason;
        this.degradedAt = Date.now();
      }
      this.manager.metrics.lastError = manifest.reason;
      this.manager.log("warn", "mirror sync failed", {
        job: this.key,
        reason: manifest.reason,
        syncReason: reason,
      });
      return { ok: false, reason: manifest.reason };
    }

    const rewritten = this.rewriteManifestForPublic(manifest.body, manifest.finalUrl);
    const nowMs = Date.now();
    this.lastObservedTargetDurationSec = rewritten.targetDurationSec || this.lastObservedTargetDurationSec;
    this.lastPlaylistMediaSeq = rewritten.mediaSequence;

    const uploads = [];
    for (const sourceUrl of rewritten.currentAssetUrls) {
      const record = this.assetsBySourceUrl.get(sourceUrl);
      if (!record) continue;
      record.lastSeenAt = nowMs;
      if (record.uploadedAt > 0) continue;
      uploads.push(record);
    }

    try {
      await mapLimit(uploads, this.manager.config.mirrorAssetConcurrency, async (record) => {
        await this.uploadAsset(record);
      });
      await this.cleanupStaleAssets(nowMs, rewritten.currentAssetUrls);

      const fingerprint = hashHex(rewritten.manifestBody);
      const shouldPublish =
        fingerprint !== this.lastPublishedPlaylistFingerprint ||
        !this.lastPublishAt ||
        nowMs - this.lastPublishAt >= this.manager.config.playlistPublishMinIntervalMs;
      if (shouldPublish) {
        await this.uploadManifest(rewritten.manifestBody);
        this.lastPublishedPlaylistFingerprint = fingerprint;
      }

      this.state = "running";
      this.degradedReason = "";
      this.degradedAt = 0;
      this.consecutiveSourceErrors = 0;
      this.lastError = "";
      return { ok: true, reason: "ok" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastErrorAt = Date.now();
      this.lastError = message;
      this.consecutiveSourceErrors += 1;
      if (this.consecutiveSourceErrors >= this.manager.config.maxConsecutiveFailures) {
        this.state = "degraded";
        this.degradedReason = message;
        this.degradedAt = Date.now();
      }
      this.manager.metrics.lastError = message;
      this.manager.log("warn", "mirror publish failed", {
        job: this.key,
        reason: message,
      });
      return { ok: false, reason: message };
    }
  }
}

class MirrorManager {
  constructor(config) {
    this.config = config;
    this.startedAt = Date.now();
    this.jobs = new Map();
    this.metrics = {
      seedRequests: 0,
      seedAccepted: 0,
      seedRejected: 0,
      seedRejectedByReason: {},
      uploadErrors: 0,
      lastError: "",
    };
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

  log(level, message, extra = {}) {
    const payload = { ts: nowIso(), level, message, ...extra };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  noteSeedReject(reason) {
    const key = String(reason || "unknown").trim() || "unknown";
    this.metrics.seedRejected += 1;
    this.metrics.seedRejectedByReason[key] = (this.metrics.seedRejectedByReason[key] || 0) + 1;
    this.metrics.lastError = key;
  }

  async purgeRemotePrefix(prefix, maxKeys) {
    const safePrefix = String(prefix || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!safePrefix) return { deleted: 0, scanned: 0, truncated: false };

    let continuationToken = undefined;
    let deleted = 0;
    let scanned = 0;
    let truncated = false;

    while (deleted < maxKeys) {
      const listed = await this.r2.send(
        new ListObjectsV2Command({
          Bucket: this.config.r2Bucket,
          Prefix: `${safePrefix}/`,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      );
      const contents = Array.isArray(listed.Contents) ? listed.Contents : [];
      const keys = contents
        .map((item) => String(item && item.Key ? item.Key : "").trim())
        .filter(Boolean)
        .filter((key) => shouldDeleteRemoteName(path.basename(key)));

      scanned += contents.length;
      if (keys.length) {
        const limitedKeys = keys.slice(0, Math.max(0, maxKeys - deleted));
        await this.r2.send(
          new DeleteObjectsCommand({
            Bucket: this.config.r2Bucket,
            Delete: {
              Objects: limitedKeys.map((key) => ({ Key: key })),
              Quiet: true,
            },
          })
        );
        deleted += limitedKeys.length;
      }

      if (!listed.IsTruncated || !listed.NextContinuationToken || deleted >= maxKeys) {
        truncated = Boolean(listed.IsTruncated && listed.NextContinuationToken);
        break;
      }
      continuationToken = listed.NextContinuationToken;
    }

    return { deleted, scanned, truncated };
  }

  async stopJob(key) {
    const job = this.jobs.get(key);
    if (!job) return;
    await job.stop();
    this.jobs.delete(key);
  }

  resolvePayload(payload) {
    const matchId = toInt(payload.matchId, NaN, 1);
    const serverId = toInt(payload.serverId, NaN, 1);
    const sourceUrl = normalizeCandidateUrl(payload.sourceUrl, this.config.playerOrigin);
    const ingestUrl = normalizeCandidateUrl(payload.ingestUrl, this.config.playerOrigin);
    const matchStatus = String(payload.matchStatus || "").trim().toLowerCase();
    const matchStartMs = parseMatchStartMs(payload.matchStart);
    return {
      matchId,
      serverId,
      sourceUrl,
      ingestUrl,
      matchStatus,
      matchStartMs,
    };
  }

  async seed(payload) {
    this.metrics.seedRequests += 1;
    const parsed = this.resolvePayload(payload || {});
    if (!Number.isFinite(parsed.matchId) || !Number.isFinite(parsed.serverId)) {
      this.noteSeedReject("invalid-input");
      return { accepted: false, reason: "invalid-input" };
    }
    if (!this.config.repackServers.has(parsed.serverId)) {
      this.noteSeedReject("server-not-enabled");
      return { accepted: false, reason: "server-not-enabled" };
    }
    if (!isHttpUrl(parsed.sourceUrl)) {
      this.noteSeedReject("invalid-source-url");
      return { accepted: false, reason: "invalid-source-url" };
    }
    if (!isStrictGatewayIngestUrl(parsed.ingestUrl, parsed.matchId, parsed.serverId)) {
      this.noteSeedReject("invalid-ingest-url");
      return { accepted: false, reason: "invalid-ingest-url" };
    }

    const nowMs = Date.now();
    const windowState = computeMatchWindowState(parsed.matchStartMs, this.config, nowMs);
    if (this.config.liveOnly) {
      if (!windowState.hasStart) {
        this.noteSeedReject("missing-match-start");
        return { accepted: false, reason: "missing-match-start" };
      }
      if (!windowState.inWindow) {
        this.noteSeedReject("match-outside-window");
        return { accepted: false, reason: "match-outside-window" };
      }
    }

    const key = buildStrictGatewayIngestUrlKey(parsed.matchId, parsed.serverId);
    let job = this.jobs.get(key);
    if (!job) {
      job = new MirrorJob(this, {
        matchId: parsed.matchId,
        serverId: parsed.serverId,
        sourceUrl: parsed.sourceUrl,
        ingestUrl: parsed.ingestUrl,
        remotePrefix: `live/m${parsed.matchId}/s${parsed.serverId}`,
      });
      this.jobs.set(key, job);
      await job.start();
      this.log("info", "mirror job started", {
        job: key,
        matchId: parsed.matchId,
        serverId: parsed.serverId,
        ingestUrl: parsed.ingestUrl,
      });
    } else {
      job.updateSeed({
        sourceUrl: parsed.sourceUrl,
        ingestUrl: parsed.ingestUrl,
      });
    }

    const synced = await job.syncNow("seed");
    if (!synced.ok) {
      this.noteSeedReject(`sync-failed:${synced.reason}`);
      return {
        accepted: false,
        reason: `sync-failed:${synced.reason}`,
        ingestUrl: parsed.ingestUrl,
      };
    }

    this.metrics.seedAccepted += 1;
    return {
      accepted: true,
      reason: "ok",
      jobKey: key,
      ingestUrl: parsed.ingestUrl,
      publicPlaylistUrl: job.publicPlaylistUrl,
    };
  }

  async stopAll() {
    const jobs = Array.from(this.jobs.values());
    for (const job of jobs) {
      await job.stop();
    }
    this.jobs.clear();
  }

  diag() {
    const jobs = Array.from(this.jobs.values()).map((job) => job.toDiag(Date.now()));
    const perServer = {};
    for (const job of jobs) {
      perServer[String(job.serverId)] = {
        repack_on: job.state === "running",
        fallback_reason_top: job.degradedReason || "none",
        cache_status_mix: "n/a",
        stall_rate: "n/a",
      };
    }
    return {
      ok: true,
      uptimeMs: Date.now() - this.startedAt,
      config: {
        bind: this.config.bind,
        port: this.config.port,
        liveOnly: this.config.liveOnly,
        prematchOpenWindowMs: this.config.prematchOpenWindowMs,
        matchDurationMs: this.config.matchDurationMs,
        postmatchGraceMs: this.config.postmatchGraceMs,
        earlyStopOnFinished: this.config.earlyStopOnFinished,
        finishedDebounceMs: this.config.finishedDebounceMs,
        earlyStopSegmentFailStreak: this.config.earlyStopSegmentFailStreak,
        preflightTimeoutMs: this.config.manifestFetchTimeoutMs,
        uploadPollMs: this.config.uploadPollMs,
        playlistPublishMinIntervalMs: this.config.playlistPublishMinIntervalMs,
        localRetentionMs: this.config.localRetentionMs,
        remoteRetentionMs: this.config.remoteRetentionMs,
        purgeRemoteOnStop: this.config.purgeRemoteOnStop,
        purgeStopMaxKeys: this.config.purgeStopMaxKeys,
        maxConsecutiveStartFailures: this.config.maxConsecutiveFailures,
        startFailureBaseBackoffMs: 0,
        startFailureMaxBackoffMs: 0,
        staleInputSequenceMs: this.config.staleInputSequenceMs,
        segmentDurationSec: 0,
        playlistSize: 0,
        repackServers: Array.from(this.config.repackServers).sort((a, b) => a - b),
        r2Bucket: this.config.r2Bucket,
        publicBaseUrl: this.config.publicBaseUrl,
      },
      metrics: this.metrics,
      jobs,
      perServer,
    };
  }
}

function loadConfig() {
  const repackServers = new Set(
    String(process.env.REPACK_SERVERS || "1,2,3,4")
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isFinite(item) && item > 0)
  );
  const prematchOpenWindowMinutes = toInt(process.env.REPACK_PREMATCH_OPEN_WINDOW_MINUTES, 30, 0);
  const matchDurationMinutes = toInt(process.env.REPACK_MATCH_DURATION_MINUTES, 180, 1);
  const postmatchGraceMinutes = toInt(process.env.REPACK_POSTMATCH_GRACE_MINUTES, 15, 0);
  const finishedDebounceMinutes = toInt(process.env.REPACK_FINISHED_DEBOUNCE_MINUTES, 5, 0);

  const config = {
    bind: String(process.env.REPACK_AGENT_BIND || "127.0.0.1").trim(),
    port: toInt(process.env.REPACK_AGENT_PORT, 3400, 1),
    workRoot: String(process.env.REPACK_WORK_ROOT || "/tmp/tf-repack").trim(),
    uploadPollMs: toInt(process.env.REPACK_UPLOAD_POLL_MS, 2000, 500),
    playlistPublishMinIntervalMs: toInt(process.env.REPACK_PLAYLIST_PUBLISH_MIN_INTERVAL_MS, 2500, 500),
    idleStopMs: toInt(process.env.REPACK_IDLE_STOP_MS, 8 * 60 * 60 * 1000, 10_000),
    localRetentionMs: toInt(process.env.REPACK_LOCAL_RETENTION_MS, 2 * 60 * 1000, 10_000),
    remoteRetentionMs: toInt(process.env.REPACK_REMOTE_RETENTION_MS, 3 * 60 * 1000, 10_000),
    purgeRemoteOnStop: toBool(process.env.REPACK_PURGE_REMOTE_ON_STOP, true),
    purgeRemoteOnStart: toBool(process.env.REPACK_PURGE_REMOTE_ON_START, true),
    purgeStopMaxKeys: toInt(process.env.REPACK_PURGE_STOP_MAX_KEYS, 30_000, 1000),
    liveOnly: toBool(process.env.REPACK_LIVE_ONLY, true),
    prematchOpenWindowMs: prematchOpenWindowMinutes * 60 * 1000,
    matchDurationMs: matchDurationMinutes * 60 * 1000,
    postmatchGraceMs: postmatchGraceMinutes * 60 * 1000,
    earlyStopOnFinished: toBool(process.env.REPACK_EARLY_STOP_ON_FINISHED, false),
    finishedDebounceMs: finishedDebounceMinutes * 60 * 1000,
    earlyStopSegmentFailStreak: toInt(process.env.REPACK_EARLY_STOP_SEGMENT_FAIL_STREAK, 4, 1),
    manifestFetchTimeoutMs: Math.max(12_000, toInt(process.env.REPACK_AGENT_PREFLIGHT_TIMEOUT_MS, 12_000, 1500)),
    assetFetchTimeoutMs: Math.max(6000, toInt(process.env.REPACK_AGENT_ASSET_FETCH_TIMEOUT_MS, 12_000, 2000)),
    maxConsecutiveFailures: toInt(process.env.REPACK_AGENT_MAX_START_FAILURES, 4, 2),
    staleInputSequenceMs: toInt(process.env.REPACK_STALE_INPUT_SEQUENCE_MS, 15_000, 5000),
    publicBaseUrl: String(process.env.REPACK_PUBLIC_BASE_URL || "https://r2.tf-player.site/live").trim().replace(/\/+$/, ""),
    playerOrigin: String(
      process.env.REPACK_INTERNAL_PLAYER_ORIGIN ||
        process.env.INTERNAL_APP_ORIGIN ||
        process.env.REPACK_PLAYER_ORIGIN ||
        "http://127.0.0.1:3000"
    ).trim(),
    repackServers,
    mirrorAssetConcurrency: toInt(process.env.REPACK_MIRROR_ASSET_CONCURRENCY, 6, 1),
    r2Endpoint: String(process.env.R2_ENDPOINT || process.env.REPACK_R2_ENDPOINT || "").trim(),
    r2Bucket: String(process.env.R2_BUCKET || process.env.REPACK_R2_BUCKET || "").trim(),
    r2AccessKeyId: String(process.env.R2_ACCESS_KEY_ID || process.env.REPACK_R2_ACCESS_KEY_ID || "").trim(),
    r2SecretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || process.env.REPACK_R2_SECRET_ACCESS_KEY || "").trim(),
  };

  if (!config.r2Endpoint || !config.r2Bucket || !config.r2AccessKeyId || !config.r2SecretAccessKey) {
    throw new Error("Missing R2 configuration (endpoint/bucket/access key/secret).");
  }
  return config;
}

async function main() {
  const config = loadConfig();
  const manager = new MirrorManager(config);
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const pathname = String((req.url || "").split("?")[0] || "/");
    try {
      if (method === "GET" && pathname === "/healthz") {
        return sendJson(res, 200, {
          ok: true,
          uptimeMs: Date.now() - startedAt,
          jobs: manager.jobs.size,
          ts: nowIso(),
        });
      }

      if (method === "GET" && pathname === "/diag") {
        return sendJson(res, 200, manager.diag());
      }

      if (method === "POST" && pathname === "/seed") {
        const payload = await readJsonBody(req);
        const result = await manager.seed(payload || {});
        if (!result.accepted) return sendJson(res, 202, result);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      manager.log("error", "http handler failed", { method, pathname, error: message });
      return sendJson(res, 500, { ok: false, error: message });
    }
  });

  server.listen(config.port, config.bind, () => {
    manager.log("info", "repackager started", {
      bind: config.bind,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      repackServers: Array.from(config.repackServers).sort((a, b) => a - b),
    });
  });

  const shutdown = async (signal) => {
    manager.log("info", "shutdown requested", { signal });
    server.close();
    await manager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[repackager] fatal: ${message}\n`);
  process.exit(1);
});
