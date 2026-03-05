#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

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
    const u = new URL(String(value || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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

function looksLikeNonStreamAssetPath(pathname) {
  const p = String(pathname || "").toLowerCase();
  if (!p) return false;
  return /\.(?:css|js|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|json|xml|txt|pdf)(?:$|\?)/i.test(p);
}

function looksLikeHlsishUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const pathname = String(url.pathname || "").toLowerCase();
    const search = String(url.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (looksLikeNonStreamAssetPath(pathname)) return false;
    if (pathname.endsWith(".mpd") || combined.includes(".mpd")) return false;
    if (pathname.includes("/dash/") && !pathname.endsWith(".m3u8") && !combined.includes(".m3u8")) return false;
    if (pathname.endsWith(".m3u8") || combined.includes(".m3u8")) return true;
    if (
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/stream/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/kooora/")
    ) {
      return true;
    }
    // Some upstreams expose manifest endpoints without .m3u8 extension.
    // Tokenized/live params are a strong signal that URL is media-like.
    if (
      search.includes("token=") ||
      search.includes("sid=") ||
      search.includes("nonce=") ||
      search.includes("ts=") ||
      search.includes("session")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isLikelyHlsManifestUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const pathname = String(url.pathname || "").toLowerCase();
    const search = String(url.search || "").toLowerCase();
    if (pathname.endsWith(".mpd") || `${pathname}${search}`.includes(".mpd")) return false;
    if (pathname.endsWith(".m3u8")) return true;
    if (`${pathname}${search}`.includes(".m3u8")) return true;
    if (pathname.includes("/api/embed-proxy")) {
      const target = safeDecodeURIComponent(String(url.searchParams.get("url") || ""));
      if (looksLikeHlsishUrl(target)) return true;
    }
    if (looksLikeHlsishUrl(url.toString())) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function detectIngestUrlKind(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "none";
  try {
    const u = new URL(value);
    const pathname = String(u.pathname || "").toLowerCase();
    if (pathname.includes("/api/embed-proxy")) return "backend_proxy_ingest";
    if (isLikelyHlsManifestUrl(value)) return "direct_m3u8";
    return "other";
  } catch {
    return "other";
  }
}

function normalizeIngestMode(rawMode, ingestUrl) {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (mode === "direct_m3u8" || mode === "backend_proxy_ingest") return mode;
  return detectIngestUrlKind(ingestUrl);
}

function normalizeHeaderValue(raw) {
  const value = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return value || "";
}

function normalizeIngestHeaders(rawHeaders, fallbackSourceUrl = "") {
  const sourceFallback = String(fallbackSourceUrl || "").trim();
  const refererInput =
    normalizeHeaderValue(rawHeaders?.referer || rawHeaders?.referrer || rawHeaders?.Referer) || sourceFallback;
  const referer = isHttpUrl(refererInput) ? refererInput : "";
  const originInput = normalizeHeaderValue(rawHeaders?.origin || rawHeaders?.Origin);
  const origin = originInput || (referer ? (() => {
    try {
      return new URL(referer).origin;
    } catch {
      return "";
    }
  })() : "");
  const userAgent = normalizeHeaderValue(
    rawHeaders?.["user-agent"] || rawHeaders?.userAgent || rawHeaders?.UserAgent || DEFAULT_USER_AGENT
  );
  return {
    referer: referer || "",
    origin: origin || "",
    "user-agent": userAgent || DEFAULT_USER_AGENT,
  };
}

function parseLastSegmentFromManifest(playlistUrl, manifestText) {
  const lines = String(manifestText || "").split(/\r?\n/);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const raw = String(lines[idx] || "").trim();
    if (!raw || raw.startsWith("#")) continue;
    try {
      const abs = new URL(raw, playlistUrl).toString();
      if (isHttpUrl(abs)) return abs;
    } catch {}
  }
  return "";
}

function parseTargetDurationSecFromPlaylistLines(lines) {
  for (const line of lines || []) {
    const raw = String(line || "").trim();
    if (!raw) continue;
    const match = raw.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match || !match[1]) continue;
    const n = Number.parseFloat(match[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function probeSegmentUrl(segmentUrl, timeoutMs, headers = {}) {
  const baseHeaders = {
    "user-agent": DEFAULT_USER_AGENT,
    ...(headers || {}),
  };
  const runTimedFetch = async (method, extraHeaders = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(segmentUrl, {
        method,
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          ...baseHeaders,
          ...(extraHeaders || {}),
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const head = await runTimedFetch("HEAD");
      if (head.ok) return { ok: true, status: head.status };
      if (head.status === 405 || head.status === 403 || head.status === 401) {
        const getResp = await runTimedFetch("GET", { range: "bytes=0-1" });
        if (getResp.ok || getResp.status === 206) return { ok: true, status: getResp.status };
        if (attempt === 0 && (getResp.status >= 500 || getResp.status === 429)) continue;
        return { ok: false, status: getResp.status };
      }
      if (attempt === 0 && (head.status >= 500 || head.status === 429)) continue;
      return { ok: false, status: head.status };
    } catch {
      if (attempt === 0) continue;
      return { ok: false, status: 0 };
    }
  }
  return { ok: false, status: 0 };
}

function readJsonBody(req, maxBytes = 64 * 1024) {
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

class RepackJob {
  constructor(manager, input) {
    this.manager = manager;
    this.matchId = input.matchId;
    this.serverId = input.serverId;
    this.ingestUrl = input.ingestUrl;
    this.ingestHeaders = normalizeIngestHeaders(input.ingestHeaders, input.ingestUrl);
    this.workDir = input.workDir;
    this.remotePrefix = input.remotePrefix.replace(/\/+$/, "");
    this.profile = input.profile;
    this.state = "starting";
    this.createdAt = Date.now();
    this.lastSeedAt = Date.now();
    this.lastPublishAt = 0;
    this.lastErrorAt = 0;
    this.sourceReadErrors = 0;
    this.consecutiveSourceErrors = 0;
    this.consecutiveUploadErrors = 0;
    this.uploadedSegments = new Map();
    this.remoteSeq = 0;
    this.lastPlaylistMediaSeq = 0;
    this.totalPlaylistPublishes = 0;
    this.totalSegmentUploads = 0;
    this.totalSegmentBytes = 0;
    this.lastUploadLatencyMs = 0;
    this.lastPlaylistLatencyMs = 0;
    this.remoteHistory = [];
    this.lastStaleRestartAt = 0;
    this.lastLocalSegmentFingerprint = "";
    this.lastLocalSegmentChangedAt = 0;
    this.lastObservedTargetDurationSec = 0;
    this.ffmpegProc = null;
    this.uploadTimer = null;
    this.monitorTimer = null;
    this.stdoutLog = [];
    this.stderrLog = [];
    this.lastFfmpegExitAt = 0;
    this.lastFfmpegExitCode = null;
    this.lastFfmpegExitSignal = null;
    this.lastSpawnAt = 0;
    this.consecutiveStartFailures = 0;
    this.degradedReason = "";
    this.degradedAt = 0;
    this.pendingHardReset = false;
    this.pendingDiscontinuity = false;
  }

  get key() {
    return `m${this.matchId}:s${this.serverId}`;
  }

  get playlistPath() {
    return path.join(this.workDir, "index.m3u8");
  }

  async start() {
    await fsp.mkdir(this.workDir, { recursive: true });
    this.spawnFfmpeg();
    const pollMs = this.manager.config.uploadPollMs;
    this.uploadTimer = setInterval(() => {
      this.syncPlaylist().catch((error) => {
        this.lastErrorAt = Date.now();
        this.consecutiveUploadErrors += 1;
        this.manager.log("warn", "repack sync failed", {
          job: this.key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, pollMs);
    this.monitorTimer = setInterval(() => this.healthSweep(), 2500);
    this.state = "running";
  }

  getAdaptiveStaleMs(baseMs, multiplier = 3) {
    const safeBase = Math.max(2000, Number(baseMs) || 0);
    const targetDurationSec = Number(this.lastObservedTargetDurationSec || 0);
    if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) return safeBase;
    const derived = Math.round(targetDurationSec * 1000 * multiplier + 2000);
    return Math.max(safeBase, Math.min(120_000, derived));
  }

  resetEncoderRunState({ hardReset = false } = {}) {
    this.lastLocalSegmentFingerprint = "";
    this.lastLocalSegmentChangedAt = 0;
    if (!hardReset) return;
    // Hard reset is reserved for first boot or source switch only.
    // Normal restarts preserve state to avoid playback gaps.
    this.uploadedSegments = new Map();
    this.lastPublishAt = 0;
    this.lastPlaylistMediaSeq = 0;
    this.pendingDiscontinuity = false;
    try {
      const entries = fs.readdirSync(this.workDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = String(entry.name || "").toLowerCase();
        if (name === "index.m3u8" || name.endsWith(".ts")) {
          try {
            fs.unlinkSync(path.join(this.workDir, entry.name));
          } catch {}
        }
      }
    } catch {}
  }

  spawnFfmpeg() {
    if (this.state === "stopped") return;
    const hardReset = this.pendingHardReset || !this.lastPublishAt;
    this.pendingHardReset = false;
    if (!hardReset && this.lastPublishAt) {
      this.pendingDiscontinuity = true;
    }
    this.resetEncoderRunState({ hardReset });
    const ffmpegBin = this.manager.config.ffmpegBin;
    const segmentPattern = path.join(this.workDir, "seg-%08d.ts");
    const ingestHeaders = normalizeIngestHeaders(this.ingestHeaders, this.ingestUrl);
    const ffUserAgent = normalizeHeaderValue(ingestHeaders["user-agent"]) || DEFAULT_USER_AGENT;
    const ffExtraHeaders = [];
    if (ingestHeaders.origin) ffExtraHeaders.push(`Origin: ${ingestHeaders.origin}`);
    if (ingestHeaders.referer) ffExtraHeaders.push(`Referer: ${ingestHeaders.referer}`);
    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-user_agent",
      ffUserAgent,
      "-rw_timeout",
      "15000000",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_at_eof",
      "1",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_delay_max",
      "2",
      "-analyzeduration",
      "10000000",
      "-probesize",
      "10000000",
      "-fflags",
      "+discardcorrupt",
      "-live_start_index",
      "-1",
    ];
    if (ingestHeaders.referer) {
      args.push("-referer", ingestHeaders.referer);
    }
    if (ffExtraHeaders.length) {
      args.push("-headers", `${ffExtraHeaders.join("\r\n")}\r\n`);
    }
    args.push(
      "-i",
      this.ingestUrl,
      "-ignore_unknown",
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-sn",
      "-dn",
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      String(this.profile.segmentDurationSec),
      "-hls_list_size",
      String(this.profile.playlistSize),
      "-hls_flags",
      "delete_segments+append_list+omit_endlist+program_date_time+temp_file",
      "-hls_segment_filename",
      segmentPattern,
      this.playlistPath
    );
    this.lastSpawnAt = Date.now();
    this.state = "starting";

    this.ffmpegProc = spawn(ffmpegBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.ffmpegProc.stdout?.on("data", (chunk) => {
      const line = String(chunk || "").trim();
      if (!line) return;
      this.stdoutLog.unshift(line);
      if (this.stdoutLog.length > 50) this.stdoutLog.length = 50;
    });

    this.ffmpegProc.stderr?.on("data", (chunk) => {
      const line = String(chunk || "").trim();
      if (!line) return;
      this.stderrLog.unshift(line);
      if (this.stderrLog.length > 80) this.stderrLog.length = 80;
      const lower = line.toLowerCase();
      if (
        lower.includes("error") ||
        lower.includes("failed") ||
        lower.includes("timed out") ||
        lower.includes("404")
      ) {
        this.sourceReadErrors += 1;
        this.consecutiveSourceErrors += 1;
        this.lastErrorAt = Date.now();
      }
    });

    this.ffmpegProc.on("exit", (code, signal) => {
      this.manager.log("warn", "ffmpeg exited", {
        job: this.key,
        code: Number.isFinite(code) ? code : null,
        signal: signal || null,
      });
      this.ffmpegProc = null;
      this.lastErrorAt = Date.now();
      this.lastFfmpegExitAt = Date.now();
      this.lastFfmpegExitCode = Number.isFinite(code) ? code : null;
      this.lastFfmpegExitSignal = signal || null;
      if (this.state === "stopped") return;

      const now = Date.now();
      const exitedQuickly = !this.lastPublishAt || now - this.lastSpawnAt <= this.manager.config.startFailureWindowMs;
      if (exitedQuickly) {
        this.consecutiveStartFailures += 1;
      } else {
        this.consecutiveStartFailures = 0;
      }

      const overFailureLimit = this.consecutiveStartFailures >= this.manager.config.maxConsecutiveStartFailures;
      if (overFailureLimit) {
        this.state = "degraded";
        this.degradedReason = "ffmpeg-restart-loop";
        this.degradedAt = now;
        this.manager.log("error", "repack degraded", {
          job: this.key,
          reason: this.degradedReason,
          consecutiveStartFailures: this.consecutiveStartFailures,
        });
        return;
      }

      const retryDelayMs = exitedQuickly
        ? Math.min(
            this.manager.config.startFailureMaxBackoffMs,
            this.manager.config.startFailureBaseBackoffMs * Math.pow(2, Math.max(0, this.consecutiveStartFailures - 1))
          )
        : 1400;
      this.state = "restarting";
      setTimeout(() => {
        if (this.state === "stopped") return;
        if (this.state === "degraded") return;
        this.spawnFfmpeg();
        this.state = "running";
      }, retryDelayMs);
    });
  }

  touchSeed(ingestUrl, opts = {}) {
    this.lastSeedAt = Date.now();
    const forceRestart = Boolean(opts.forceRestart);
    const nextHeaders = normalizeIngestHeaders(opts.ingestHeaders || this.ingestHeaders, ingestUrl || this.ingestUrl);
    const headersChanged =
      normalizeHeaderValue(nextHeaders.referer) !== normalizeHeaderValue(this.ingestHeaders?.referer) ||
      normalizeHeaderValue(nextHeaders.origin) !== normalizeHeaderValue(this.ingestHeaders?.origin) ||
      normalizeHeaderValue(nextHeaders["user-agent"]) !== normalizeHeaderValue(this.ingestHeaders?.["user-agent"]);
    if (headersChanged) {
      this.ingestHeaders = nextHeaders;
    }

    if (ingestUrl && ingestUrl !== this.ingestUrl) {
      this.ingestUrl = ingestUrl;
      this.pendingHardReset = true;
      this.consecutiveStartFailures = 0;
      this.degradedReason = "";
      this.degradedAt = 0;
      this.manager.log("info", "repack source updated", { job: this.key });
      if (this.ffmpegProc) {
        try {
          this.ffmpegProc.kill("SIGTERM");
        } catch {}
      } else {
        this.spawnFfmpeg();
      }
      return;
    }
    if (headersChanged && this.ffmpegProc) {
      this.manager.log("info", "repack source headers updated", { job: this.key });
      try {
        this.ffmpegProc.kill("SIGTERM");
      } catch {}
      return;
    }
    if (this.state === "degraded" || forceRestart) {
      this.consecutiveStartFailures = 0;
      this.degradedReason = "";
      this.degradedAt = 0;
      this.state = "starting";
      this.manager.log("info", "repack degraded recovery requested", { job: this.key, forceRestart });
      if (this.ffmpegProc) {
        try {
          this.ffmpegProc.kill("SIGTERM");
        } catch {}
      } else {
        this.spawnFfmpeg();
      }
      return;
    }

    // If source is unchanged but stream is stale/restarting, force ffmpeg recycle.
    const now = Date.now();
    const staleMs = this.getAdaptiveStaleMs(this.manager.config.seedRestartStaleMs, 8);
    const noPublishYet = !this.lastPublishAt && now - this.createdAt > staleMs;
    const stalePublish = !!this.lastPublishAt && now - this.lastPublishAt > staleMs;
    const recentlySpawned = this.lastSpawnAt && now - this.lastSpawnAt < Math.max(5000, Math.floor(staleMs * 0.4));
    if ((this.state === "restarting" || noPublishYet || stalePublish) && this.ffmpegProc && !recentlySpawned) {
      this.manager.log("warn", "repack seed-triggered restart", {
        job: this.key,
        staleThresholdMs: staleMs,
        staleMs: this.lastPublishAt ? now - this.lastPublishAt : now - this.createdAt,
      });
      try {
        this.ffmpegProc.kill("SIGTERM");
      } catch {}
    }
  }

  parsePlaylist(rawText) {
    const lines = String(rawText || "").split(/\r?\n/);
    const segmentLines = [];
    for (const line of lines) {
      const value = String(line || "").trim();
      if (!value || value.startsWith("#")) continue;
      segmentLines.push(value);
    }
    return { lines, segmentLines };
  }

  buildRemoteSegmentName() {
    const nowMs = Date.now();
    this.remoteSeq += 1;
    return `seg-${nowMs}-${String(this.remoteSeq).padStart(6, "0")}.ts`;
  }

  async uploadSegment(localName, providedStat = null) {
    const localPath = path.join(this.workDir, localName);
    let stat = providedStat;
    try {
      if (!stat) stat = await fsp.stat(localPath);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size <= 0) return false;
    const localSignature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;

    const remoteName = this.buildRemoteSegmentName();
    const remoteKey = `${this.remotePrefix}/${remoteName}`;
    const startedAt = Date.now();
    const fileBody = await fsp.readFile(localPath);
    await this.manager.putObject({
      key: remoteKey,
      body: fileBody,
      contentType: "video/mp2t",
      cacheControl: "public, max-age=30, s-maxage=120, stale-while-revalidate=30",
    });

    this.lastUploadLatencyMs = Date.now() - startedAt;
    this.totalSegmentUploads += 1;
    this.totalSegmentBytes += stat.size;
    this.uploadedSegments.set(localName, {
      remoteName,
      remoteKey,
      remoteSeq: this.remoteSeq,
      uploadedAt: Date.now(),
      bytes: stat.size,
      localSignature,
    });
    this.remoteHistory.push({
      key: remoteKey,
      uploadedAt: Date.now(),
    });
    if (this.remoteHistory.length > 2000) this.remoteHistory.splice(0, this.remoteHistory.length - 1200);
    return true;
  }

  async uploadPlaylist(lines) {
    const startedAt = Date.now();
    const rewrittenLines = [];
    const activeRemoteSeq = [];
    let mediaSeqLineIndex = -1;
    let insertedDiscontinuity = false;
    for (const line of lines) {
      const rawLine = String(line || "");
      const trimmed = rawLine.trim();
      if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(trimmed)) {
        mediaSeqLineIndex = rewrittenLines.length;
        rewrittenLines.push(rawLine);
        continue;
      }
      if (!trimmed || trimmed.startsWith("#")) {
        rewrittenLines.push(rawLine);
        continue;
      }
      const mapped = this.uploadedSegments.get(trimmed);
      if (mapped) {
        if (this.pendingDiscontinuity && !insertedDiscontinuity) {
          rewrittenLines.push("#EXT-X-DISCONTINUITY");
          insertedDiscontinuity = true;
        }
        rewrittenLines.push(mapped.remoteName);
        if (Number.isFinite(mapped.remoteSeq) && mapped.remoteSeq > 0) {
          activeRemoteSeq.push(mapped.remoteSeq);
        }
        continue;
      }
      rewrittenLines.push(rawLine);
    }

    if (activeRemoteSeq.length) {
      let mediaSequence = Math.min(...activeRemoteSeq);
      if (!Number.isFinite(mediaSequence) || mediaSequence < 1) mediaSequence = 1;
      if (this.lastPlaylistMediaSeq > 0 && mediaSequence < this.lastPlaylistMediaSeq) {
        mediaSequence = this.lastPlaylistMediaSeq;
      }
      this.lastPlaylistMediaSeq = mediaSequence;
      const seqLine = `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`;
      if (mediaSeqLineIndex >= 0) {
        rewrittenLines[mediaSeqLineIndex] = seqLine;
      } else {
        let insertAt = rewrittenLines.findIndex((line) => /^#EXT-X-TARGETDURATION:/i.test(String(line || "").trim()));
        if (insertAt < 0) insertAt = rewrittenLines.findIndex((line) => /^#EXT-X-VERSION:/i.test(String(line || "").trim()));
        if (insertAt < 0) insertAt = rewrittenLines.findIndex((line) => /^#EXTM3U$/i.test(String(line || "").trim()));
        if (insertAt >= 0) rewrittenLines.splice(insertAt + 1, 0, seqLine);
        else rewrittenLines.unshift(seqLine);
      }
    }

    const rewritten = rewrittenLines.join("\n");

    await this.manager.putObject({
      key: `${this.remotePrefix}/index.m3u8`,
      body: Buffer.from(rewritten, "utf8"),
      contentType: "application/vnd.apple.mpegurl; charset=utf-8",
      cacheControl: "no-store, no-cache, must-revalidate, max-age=0",
    });
    this.lastPlaylistLatencyMs = Date.now() - startedAt;
    this.lastPublishAt = Date.now();
    if (insertedDiscontinuity) {
      this.pendingDiscontinuity = false;
    }
    this.totalPlaylistPublishes += 1;
    this.consecutiveUploadErrors = 0;
    this.consecutiveSourceErrors = 0;
  }

  async syncPlaylist() {
    if (this.state === "stopped") return;
    let playlistRaw;
    try {
      playlistRaw = await fsp.readFile(this.playlistPath, "utf8");
    } catch {
      return;
    }
    const { lines, segmentLines } = this.parsePlaylist(playlistRaw);
    const targetDurationSec = parseTargetDurationSecFromPlaylistLines(lines);
    if (targetDurationSec > 0) this.lastObservedTargetDurationSec = targetDurationSec;
    if (!segmentLines.length) return;
    const now = Date.now();
    const localFingerprint = segmentLines.slice(-3).join("|");
    if (!this.lastLocalSegmentFingerprint || this.lastLocalSegmentFingerprint !== localFingerprint) {
      this.lastLocalSegmentFingerprint = localFingerprint;
      this.lastLocalSegmentChangedAt = now;
    } else {
      const staleForMs = this.lastLocalSegmentChangedAt ? now - this.lastLocalSegmentChangedAt : 0;
      const staleInputThresholdMs = this.getAdaptiveStaleMs(this.manager.config.staleInputSequenceMs, 12);
      if (
        staleForMs > staleInputThresholdMs &&
        this.ffmpegProc &&
        now - this.lastStaleRestartAt >= this.manager.config.staleRestartCooldownMs
      ) {
        this.lastStaleRestartAt = now;
        this.manager.log("warn", "repack local-segments-stale", {
          job: this.key,
          staleMs: staleForMs,
          staleThresholdMs: staleInputThresholdMs,
          targetDurationSec: this.lastObservedTargetDurationSec || 0,
        });
        try {
          this.ffmpegProc.kill("SIGTERM");
        } catch {}
      }
    }

    for (const segmentName of segmentLines) {
      const localPath = path.join(this.workDir, segmentName);
      let stat;
      try {
        stat = await fsp.stat(localPath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size <= 0) return;
      const localSignature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
      const existing = this.uploadedSegments.get(segmentName);
      if (existing && existing.localSignature === localSignature) continue;
      const ok = await this.uploadSegment(segmentName, stat);
      if (!ok) return;
    }

    for (const segmentName of segmentLines) {
      if (!this.uploadedSegments.has(segmentName)) return;
    }

    await this.uploadPlaylist(lines);
    await this.cleanupLocal(segmentLines);
    await this.cleanupRemote(segmentLines);
  }

  async cleanupLocal(activeSegments) {
    const safeSet = new Set(activeSegments);
    const retentionMs = this.manager.config.localRetentionMs;
    const now = Date.now();
    let files = [];
    try {
      files = await fsp.readdir(this.workDir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      if (safeSet.has(file)) continue;
      const filePath = path.join(this.workDir, file);
      try {
        const stat = await fsp.stat(filePath);
        if (now - stat.mtimeMs < retentionMs) continue;
        await fsp.unlink(filePath);
      } catch {}
    }
  }

  async cleanupRemote(activeSegments) {
    const activeRemote = new Set(
      activeSegments.map((name) => this.uploadedSegments.get(name)?.remoteKey).filter(Boolean)
    );
    const now = Date.now();
    const retentionMs = this.manager.config.remoteRetentionMs;
    const staleKeys = [];

    for (const [localName, meta] of this.uploadedSegments.entries()) {
      if (activeRemote.has(meta.remoteKey)) continue;
      if (now - meta.uploadedAt < retentionMs) continue;
      staleKeys.push({ localName, remoteKey: meta.remoteKey });
    }

    if (!staleKeys.length) return;
    for (const item of staleKeys.slice(0, 12)) {
      try {
        await this.manager.deleteObject(item.remoteKey);
      } catch {}
      this.uploadedSegments.delete(item.localName);
    }
  }

  healthSweep() {
    const now = Date.now();
    if (now - this.lastSeedAt > this.manager.config.idleStopMs) {
      this.manager.log("info", "repack idle-stop", { job: this.key });
      this.stop();
      return;
    }
    const staleMs = this.getAdaptiveStaleMs(this.manager.config.stalePublishMs, 8);
    if (this.lastPublishAt && now - this.lastPublishAt > staleMs) {
      const staleForMs = now - this.lastPublishAt;
      this.manager.log("warn", "repack stale publish", {
        job: this.key,
        staleMs: staleForMs,
        staleThresholdMs: staleMs,
        targetDurationSec: this.lastObservedTargetDurationSec || 0,
      });
      const restartCooldownMs = this.manager.config.staleRestartCooldownMs;
      if (this.ffmpegProc && now - this.lastStaleRestartAt >= restartCooldownMs) {
        this.lastStaleRestartAt = now;
        this.manager.log("warn", "repack stale restart", {
          job: this.key,
          staleMs: staleForMs,
          staleThresholdMs: staleMs,
        });
        try {
          this.ffmpegProc.kill("SIGTERM");
        } catch {}
      }
    }
  }

  async stop() {
    if (this.state === "stopped") return;
    this.state = "stopped";
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.uploadTimer = null;
    this.monitorTimer = null;
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill("SIGTERM");
      } catch {}
      this.ffmpegProc = null;
    }
  }

  toDiag() {
    return {
      key: this.key,
      matchId: this.matchId,
      serverId: this.serverId,
      state: this.state,
      ingestUrl: this.ingestUrl,
      ingestUrlKind: detectIngestUrlKind(this.ingestUrl),
      ingestHeaders: {
        referer: normalizeHeaderValue(this.ingestHeaders?.referer) || "",
        origin: normalizeHeaderValue(this.ingestHeaders?.origin) || "",
        userAgentSet: Boolean(normalizeHeaderValue(this.ingestHeaders?.["user-agent"])),
      },
      createdAt: this.createdAt,
      lastSeedAt: this.lastSeedAt,
      lastPublishAt: this.lastPublishAt,
      lastPublishAgeMs: this.lastPublishAt ? Math.max(0, Date.now() - this.lastPublishAt) : null,
      lastObservedTargetDurationSec: this.lastObservedTargetDurationSec || null,
      lastErrorAt: this.lastErrorAt,
      lastFfmpegExit: this.lastFfmpegExitAt
        ? {
            at: this.lastFfmpegExitAt,
            code: this.lastFfmpegExitCode,
            signal: this.lastFfmpegExitSignal,
          }
        : null,
      consecutiveStartFailures: this.consecutiveStartFailures,
      degradedAt: this.degradedAt || null,
      degradedReason: this.degradedReason || null,
      sourceReadErrors: this.sourceReadErrors,
      consecutiveSourceErrors: this.consecutiveSourceErrors,
      consecutiveUploadErrors: this.consecutiveUploadErrors,
      totalPlaylistPublishes: this.totalPlaylistPublishes,
      totalSegmentUploads: this.totalSegmentUploads,
      totalSegmentBytes: this.totalSegmentBytes,
      lastUploadLatencyMs: this.lastUploadLatencyMs,
      lastPlaylistLatencyMs: this.lastPlaylistLatencyMs,
      stderrTail: this.stderrLog.slice(0, 20),
    };
  }
}

class RepackManager {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.finishedSeenAtByJob = new Map();
    this.startedAt = Date.now();
    this.metrics = {
      seedRequests: 0,
      seedAccepted: 0,
      seedRejected: 0,
      seedRejectedByReason: {},
      seedPreflightFailed: 0,
      uploadErrors: 0,
      lastError: "",
    };

    this.s3 = new S3Client({
      region: "auto",
      endpoint: config.r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    });
  }

  noteFinishedSeenAt(jobKey, isFinished, nowMs) {
    if (!jobKey) return null;
    if (!isFinished) {
      this.finishedSeenAtByJob.delete(jobKey);
      return null;
    }
    const existing = this.finishedSeenAtByJob.get(jobKey);
    if (Number.isFinite(existing)) return Number(existing);
    this.finishedSeenAtByJob.set(jobKey, nowMs);
    return nowMs;
  }

  log(level, message, extra = {}) {
    const record = { ts: nowIso(), level, message, ...extra };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  async putObject(input) {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.r2Bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          CacheControl: input.cacheControl,
        })
      );
    } catch (error) {
      this.metrics.uploadErrors += 1;
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async deleteObject(key) {
    try {
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.config.r2Bucket,
          Key: key,
        })
      );
    } catch (error) {
      this.metrics.uploadErrors += 1;
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  noteSeedReject(reason) {
    const key = String(reason || "unknown").trim() || "unknown";
    this.metrics.seedRejected += 1;
    this.metrics.seedRejectedByReason[key] = (this.metrics.seedRejectedByReason[key] || 0) + 1;
  }

  resolveIngestPayload(payload) {
    const ingestVerified = payload?.ingestVerified === true;
    const ingestHeaders = normalizeIngestHeaders(payload?.ingestHeaders, payload?.sourceUrl);
    const explicitIngest = normalizeCandidateUrl(payload?.ingestUrl, this.config.playerOrigin);
    if (explicitIngest && ingestVerified && isHttpUrl(explicitIngest)) {
      return {
        ingestUrl: explicitIngest,
        ingestMode: normalizeIngestMode(payload.ingestMode, explicitIngest),
        ingestVerified: true,
        ingestHeaders,
      };
    }

    const candidate = normalizeCandidateUrl(payload?.sourceCandidate, this.config.playerOrigin);
    if (candidate && isLikelyHlsManifestUrl(candidate)) {
      return {
        ingestUrl: candidate,
        ingestMode: normalizeIngestMode(payload.ingestMode, candidate),
        ingestVerified,
        ingestHeaders,
      };
    }

    const source = normalizeCandidateUrl(payload?.sourceUrl, this.config.playerOrigin);
    if (source && isLikelyHlsManifestUrl(source)) {
      return {
        ingestUrl: source,
        ingestMode: normalizeIngestMode(payload.ingestMode, source),
        ingestVerified,
        ingestHeaders,
      };
    }

    return {
      ingestUrl: "",
      ingestMode: "none",
      ingestVerified,
      ingestHeaders,
    };
  }

  async preflightIngest(ingestUrl, ingestMode, ingestHeaders = {}) {
    const timeoutMs = this.config.preflightTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const headers = normalizeIngestHeaders(ingestHeaders, ingestUrl);
    const requestHeaders = {
      accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
      "user-agent": headers["user-agent"] || DEFAULT_USER_AGENT,
    };
    if (headers.referer) requestHeaders.referer = headers.referer;
    if (headers.origin) requestHeaders.origin = headers.origin;
    try {
      const response = await fetch(ingestUrl, {
        method: "GET",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: requestHeaders,
      });
      const body = await response.text();
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const finalUrl = response.url || ingestUrl;
      const evidenceBase = {
        ingestMode,
        ingestUrl,
        finalUrl,
        playlistStatus: response.status,
        segmentStatus: 0,
        contentType,
        segmentUrl: null,
      };

      if (!response.ok) {
        return { ok: false, reason: `http-${response.status}`, evidence: evidenceBase };
      }
      const looksLikeManifest =
        body.includes("#EXTM3U") ||
        contentType.includes("application/vnd.apple.mpegurl") ||
        contentType.includes("application/x-mpegurl") ||
        (looksLikeHlsishUrl(finalUrl) && /#EXTINF:|#EXT-X-TARGETDURATION|#EXT-X-MEDIA-SEQUENCE/i.test(body));
      if (!looksLikeManifest) {
        return { ok: false, reason: "non-manifest", evidence: evidenceBase };
      }

      const segmentUrl = parseLastSegmentFromManifest(finalUrl, body);
      if (!segmentUrl) {
        return { ok: false, reason: "manifest-empty", evidence: evidenceBase };
      }

      const segmentProbe = await probeSegmentUrl(
        segmentUrl,
        Math.max(900, Math.floor(timeoutMs * 0.85)),
        requestHeaders
      );
      if (!segmentProbe.ok) {
        return {
          ok: false,
          reason: `segment-http-${segmentProbe.status || 0}`,
          evidence: {
            ...evidenceBase,
            segmentUrl,
            segmentStatus: segmentProbe.status || 0,
          },
        };
      }

      return {
        ok: true,
        reason: "preflight-ok",
        evidence: {
          ...evidenceBase,
          segmentUrl,
          segmentStatus: segmentProbe.status,
        },
      };
    } catch (error) {
      return {
        ok: false,
        reason: "fetch-failed",
        evidence: {
          ingestMode,
          ingestUrl,
          finalUrl: ingestUrl,
          playlistStatus: 0,
          segmentStatus: 0,
          contentType: "",
          segmentUrl: null,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async seed(payload) {
    this.metrics.seedRequests += 1;
    const matchId = toInt(payload.matchId, NaN, 1);
    const serverId = toInt(payload.serverId, NaN, 1);
    const matchStatus = String(payload.matchStatus || "").trim().toLowerCase();
    const matchStartMs = parseMatchStartMs(payload.matchStart);
    const liveOnly = this.config.liveOnly;

    if (!Number.isFinite(matchId) || !Number.isFinite(serverId)) {
      this.noteSeedReject("invalid-input");
      return { accepted: false, reason: "invalid-input" };
    }
    if (!this.config.repackServers.has(serverId)) {
      this.noteSeedReject("server-not-enabled");
      return { accepted: false, reason: "server-not-enabled" };
    }
    const key = `m${matchId}:s${serverId}`;
    const nowMs = Date.now();
    const windowState = computeMatchWindowState(matchStartMs, this.config, nowMs);
    if (liveOnly) {
      if (!windowState.hasStart) {
        this.noteSeedReject("missing-match-start");
        return { accepted: false, reason: "missing-match-start" };
      }
      if (!windowState.inWindow) {
        this.noteSeedReject("match-outside-window");
        return { accepted: false, reason: "match-outside-window" };
      }
    }
    const seenFinishedAt = this.noteFinishedSeenAt(key, matchStatus === "finished", nowMs);
    const existingJob = this.jobs.get(key);
    if (this.config.earlyStopOnFinished && seenFinishedAt !== null) {
      const finishedStableForMs = Math.max(0, nowMs - seenFinishedAt);
      const finishedDebounced = finishedStableForMs >= this.config.finishedDebounceMs;
      const sourceFailTrend = existingJob?.consecutiveSourceErrors || 0;
      if (finishedDebounced && sourceFailTrend >= this.config.earlyStopSegmentFailStreak) {
        if (existingJob) {
          await existingJob.stop();
          this.jobs.delete(key);
        }
        this.noteSeedReject("early-stop-finished+segment-fail");
        return {
          accepted: false,
          reason: "early-stop-finished+segment-fail",
          finishedStableForMs,
          sourceFailTrend,
        };
      }
    }
    const ingest = this.resolveIngestPayload(payload || {});
    const ingestUrl = ingest.ingestUrl;
    if (!isHttpUrl(ingestUrl)) {
      this.noteSeedReject("invalid-ingest-url");
      return { accepted: false, reason: "invalid-ingest-url", ingestMode: ingest.ingestMode };
    }

    const preflight = await this.preflightIngest(ingestUrl, ingest.ingestMode, ingest.ingestHeaders);
    const upstreamProbe = payload?.probeEvidence || null;
    const upstreamProbePlaylistStatus = Number.parseInt(String(upstreamProbe?.playlistStatus || 0), 10) || 0;
    const upstreamProbeSegmentStatus = Number.parseInt(String(upstreamProbe?.segmentStatus || 0), 10) || 0;
    const canBypass403Preflight =
      !preflight.ok &&
      preflight.reason === "http-403" &&
      ingest.ingestVerified === true &&
      upstreamProbePlaylistStatus >= 200 &&
      upstreamProbePlaylistStatus < 300 &&
      upstreamProbeSegmentStatus >= 200 &&
      upstreamProbeSegmentStatus < 300;
    if (!preflight.ok && !canBypass403Preflight) {
      this.metrics.seedPreflightFailed += 1;
      const reason = `preflight-failed:${preflight.reason}`;
      this.noteSeedReject(reason);
      return {
        accepted: false,
        reason,
        ingestUrl,
        ingestMode: ingest.ingestMode,
        ingestVerified: ingest.ingestVerified,
        ingestHeaders: ingest.ingestHeaders,
        preflight: preflight.evidence,
      };
    }
    if (canBypass403Preflight) {
      this.log("warn", "repack preflight bypassed for verified ingest", {
        matchId,
        serverId,
        ingestUrl,
        reason: preflight.reason,
      });
    }

    let job = existingJob || this.jobs.get(key);
    const forceRestart = Boolean(job && job.state === "degraded");
    if (!job) {
      const workDir = path.join(this.config.workRoot, `m${matchId}`, `s${serverId}`);
      const remotePrefix = `live/m${matchId}/s${serverId}`;
      job = new RepackJob(this, {
        matchId,
        serverId,
        ingestUrl,
        ingestHeaders: ingest.ingestHeaders,
        workDir,
        remotePrefix,
        profile: this.config.repackProfile,
      });
      this.jobs.set(key, job);
      await job.start();
      this.log("info", "repack job started", {
        job: key,
        matchId,
        serverId,
        source: ingestUrl,
        ingestMode: ingest.ingestMode,
      });
    } else {
      job.touchSeed(ingestUrl, { forceRestart, ingestHeaders: ingest.ingestHeaders });
    }
    this.metrics.seedAccepted += 1;
    return {
      accepted: true,
      reason: "ok",
      jobKey: key,
      ingestUrl,
      ingestMode: ingest.ingestMode,
      ingestVerified: ingest.ingestVerified,
      ingestHeaders: ingest.ingestHeaders,
      preflight: canBypass403Preflight ? upstreamProbe : preflight.evidence,
    };
  }

  async stopAll() {
    const jobs = Array.from(this.jobs.values());
    for (const job of jobs) {
      await job.stop();
    }
    this.jobs.clear();
    this.finishedSeenAtByJob.clear();
  }

  diag() {
    const jobs = Array.from(this.jobs.values()).map((job) => job.toDiag());
    const perServer = {};
    for (const job of jobs) {
      perServer[String(job.serverId)] = {
        repack_on: job.state === "running" || job.state === "restarting",
        fallback_reason_top:
          job.consecutiveSourceErrors > 0
            ? "source-errors"
            : job.consecutiveUploadErrors > 0
              ? "upload-errors"
              : "none",
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
        preflightTimeoutMs: this.config.preflightTimeoutMs,
        maxConsecutiveStartFailures: this.config.maxConsecutiveStartFailures,
        startFailureBaseBackoffMs: this.config.startFailureBaseBackoffMs,
        startFailureMaxBackoffMs: this.config.startFailureMaxBackoffMs,
        staleInputSequenceMs: this.config.staleInputSequenceMs,
        segmentDurationSec: this.config.repackProfile.segmentDurationSec,
        playlistSize: this.config.repackProfile.playlistSize,
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

  const cfg = {
    bind: String(process.env.REPACK_AGENT_BIND || "127.0.0.1").trim(),
    port: toInt(process.env.REPACK_AGENT_PORT, 3400, 1),
    ffmpegBin: String(process.env.REPACK_FFMPEG_BIN || "ffmpeg").trim(),
    workRoot: String(process.env.REPACK_WORK_ROOT || "/tmp/tf-repack").trim(),
    uploadPollMs: toInt(process.env.REPACK_UPLOAD_POLL_MS, 1200, 400),
    // Keep seeded jobs alive long enough for full match windows unless explicitly overridden by env.
    idleStopMs: toInt(process.env.REPACK_IDLE_STOP_MS, 8 * 60 * 60 * 1000, 10_000),
    stalePublishMs: toInt(process.env.REPACK_STALE_PUBLISH_MS, 8_000, 3000),
    staleRestartCooldownMs: toInt(process.env.REPACK_STALE_RESTART_COOLDOWN_MS, 9_000, 3000),
    staleInputSequenceMs: toInt(process.env.REPACK_STALE_INPUT_SEQUENCE_MS, 15_000, 5000),
    seedRestartStaleMs: toInt(process.env.REPACK_SEED_RESTART_STALE_MS, 7_000, 3000),
    localRetentionMs: toInt(process.env.REPACK_LOCAL_RETENTION_MS, 8 * 60 * 1000, 30_000),
    remoteRetentionMs: toInt(process.env.REPACK_REMOTE_RETENTION_MS, 8 * 60 * 1000, 30_000),
    liveOnly: toBool(process.env.REPACK_LIVE_ONLY, true),
    prematchOpenWindowMs: prematchOpenWindowMinutes * 60 * 1000,
    matchDurationMs: matchDurationMinutes * 60 * 1000,
    postmatchGraceMs: postmatchGraceMinutes * 60 * 1000,
    earlyStopOnFinished: toBool(process.env.REPACK_EARLY_STOP_ON_FINISHED, false),
    finishedDebounceMs: finishedDebounceMinutes * 60 * 1000,
    earlyStopSegmentFailStreak: toInt(process.env.REPACK_EARLY_STOP_SEGMENT_FAIL_STREAK, 4, 1),
    preflightTimeoutMs: toInt(process.env.REPACK_AGENT_PREFLIGHT_TIMEOUT_MS, 2200, 900),
    maxConsecutiveStartFailures: toInt(process.env.REPACK_AGENT_MAX_START_FAILURES, 6, 2),
    startFailureBaseBackoffMs: toInt(process.env.REPACK_START_FAILURE_BASE_BACKOFF_MS, 2000, 300),
    startFailureMaxBackoffMs: toInt(process.env.REPACK_START_FAILURE_MAX_BACKOFF_MS, 20000, 1200),
    startFailureWindowMs: toInt(process.env.REPACK_START_FAILURE_WINDOW_MS, 4500, 800),
    deleteRemoteIndexAfterStartFailures: toInt(process.env.REPACK_DELETE_REMOTE_INDEX_AFTER_START_FAILURES, 3, 1),
    publicBaseUrl: String(process.env.REPACK_PUBLIC_BASE_URL || "https://r2.tf-player.site/live").trim(),
    playerOrigin: String(process.env.REPACK_PLAYER_ORIGIN || "https://tf-player.site").trim(),
    repackServers,
    repackProfile: {
      segmentDurationSec: toInt(process.env.REPACK_SEGMENT_DURATION_SEC, 1, 1),
      playlistSize: toInt(process.env.REPACK_PLAYLIST_SIZE, 5, 2),
    },
    r2Endpoint: String(process.env.R2_ENDPOINT || process.env.REPACK_R2_ENDPOINT || "").trim(),
    r2Bucket: String(process.env.R2_BUCKET || process.env.REPACK_R2_BUCKET || "").trim(),
    r2AccessKeyId: String(process.env.R2_ACCESS_KEY_ID || process.env.REPACK_R2_ACCESS_KEY_ID || "").trim(),
    r2SecretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || process.env.REPACK_R2_SECRET_ACCESS_KEY || "").trim(),
  };

  if (!cfg.r2Endpoint || !cfg.r2Bucket || !cfg.r2AccessKeyId || !cfg.r2SecretAccessKey) {
    throw new Error("Missing R2 configuration (endpoint/bucket/access key/secret).");
  }
  return cfg;
}

async function main() {
  const config = loadConfig();
  await fsp.mkdir(config.workRoot, { recursive: true });
  const manager = new RepackManager(config);
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
