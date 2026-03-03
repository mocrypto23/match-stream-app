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
    this.workDir = input.workDir;
    this.remotePrefix = input.remotePrefix.replace(/\/+$/, "");
    this.profile = input.profile;
    this.state = "starting";
    this.createdAt = Date.now();
    this.lastSeedAt = Date.now();
    this.lastPublishAt = 0;
    this.lastErrorAt = 0;
    this.sourceReadErrors = 0;
    this.consecutiveUploadErrors = 0;
    this.uploadedSegments = new Map();
    this.remoteSeq = 0;
    this.totalPlaylistPublishes = 0;
    this.totalSegmentUploads = 0;
    this.totalSegmentBytes = 0;
    this.lastUploadLatencyMs = 0;
    this.lastPlaylistLatencyMs = 0;
    this.remoteHistory = [];
    this.lastStaleRestartAt = 0;
    this.ffmpegProc = null;
    this.uploadTimer = null;
    this.monitorTimer = null;
    this.stdoutLog = [];
    this.stderrLog = [];
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

  resetEncoderRunState() {
    // ffmpeg may restart and reuse local names (seg-00000001.ts ...).
    // Reset mappings to avoid reusing stale remote segment links.
    this.uploadedSegments = new Map();
    this.lastPublishAt = 0;
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
    this.resetEncoderRunState();
    const ffmpegBin = this.manager.config.ffmpegBin;
    const segmentPattern = path.join(this.workDir, "seg-%08d.ts");
    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-user_agent",
      DEFAULT_USER_AGENT,
      "-rw_timeout",
      "15000000",
      "-live_start_index",
      "-1",
      "-i",
      this.ingestUrl,
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      String(this.profile.segmentDurationSec),
      "-hls_list_size",
      String(this.profile.playlistSize),
      "-hls_flags",
      "delete_segments+omit_endlist+program_date_time+split_by_time",
      "-hls_segment_filename",
      segmentPattern,
      this.playlistPath,
    ];

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
      if (this.state === "stopped") return;
      this.state = "restarting";
      setTimeout(() => {
        if (this.state === "stopped") return;
        this.spawnFfmpeg();
        this.state = "running";
      }, 1400);
    });
  }

  touchSeed(ingestUrl) {
    this.lastSeedAt = Date.now();
    if (ingestUrl && ingestUrl !== this.ingestUrl) {
      this.ingestUrl = ingestUrl;
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

    // If source is unchanged but stream is stale/restarting, force ffmpeg recycle.
    const now = Date.now();
    const staleMs = this.manager.config.seedRestartStaleMs;
    const noPublishYet = !this.lastPublishAt && now - this.createdAt > staleMs;
    const stalePublish = !!this.lastPublishAt && now - this.lastPublishAt > staleMs;
    if ((this.state === "restarting" || noPublishYet || stalePublish) && this.ffmpegProc) {
      this.manager.log("warn", "repack seed-triggered restart", {
        job: this.key,
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
    const rewritten = lines
      .map((line) => {
        const trimmed = String(line || "").trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const mapped = this.uploadedSegments.get(trimmed);
        return mapped ? mapped.remoteName : line;
      })
      .join("\n");

    await this.manager.putObject({
      key: `${this.remotePrefix}/index.m3u8`,
      body: Buffer.from(rewritten, "utf8"),
      contentType: "application/vnd.apple.mpegurl; charset=utf-8",
      cacheControl: "no-store, no-cache, must-revalidate, max-age=0",
    });
    this.lastPlaylistLatencyMs = Date.now() - startedAt;
    this.lastPublishAt = Date.now();
    this.totalPlaylistPublishes += 1;
    this.consecutiveUploadErrors = 0;
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
    if (!segmentLines.length) return;

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
    const staleMs = this.manager.config.stalePublishMs;
    if (this.lastPublishAt && now - this.lastPublishAt > staleMs) {
      const staleForMs = now - this.lastPublishAt;
      this.manager.log("warn", "repack stale publish", { job: this.key, staleMs: staleForMs });
      const restartCooldownMs = this.manager.config.staleRestartCooldownMs;
      if (this.ffmpegProc && now - this.lastStaleRestartAt >= restartCooldownMs) {
        this.lastStaleRestartAt = now;
        this.manager.log("warn", "repack stale restart", { job: this.key, staleMs: staleForMs });
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
      createdAt: this.createdAt,
      lastSeedAt: this.lastSeedAt,
      lastPublishAt: this.lastPublishAt,
      lastErrorAt: this.lastErrorAt,
      sourceReadErrors: this.sourceReadErrors,
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
    this.startedAt = Date.now();
    this.metrics = {
      seedRequests: 0,
      seedAccepted: 0,
      seedRejected: 0,
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

  resolveIngestUrl(payload) {
    const candidate = normalizeCandidateUrl(payload.sourceCandidate, this.config.playerOrigin);
    if (candidate && isLikelyHlsManifestUrl(candidate)) return candidate;
    const source = normalizeCandidateUrl(payload.sourceUrl, this.config.playerOrigin);
    if (source && isLikelyHlsManifestUrl(source)) return source;
    return "";
  }

  async seed(payload) {
    this.metrics.seedRequests += 1;
    const matchId = toInt(payload.matchId, NaN, 1);
    const serverId = toInt(payload.serverId, NaN, 1);
    const matchStatus = String(payload.matchStatus || "").trim().toLowerCase();
    const matchStartMs = Number.parseInt(String(new Date(String(payload.matchStart || "")).getTime()), 10);
    const liveOnly = this.config.liveOnly;

    if (!Number.isFinite(matchId) || !Number.isFinite(serverId)) {
      this.metrics.seedRejected += 1;
      return { accepted: false, reason: "invalid-input" };
    }
    if (!this.config.repackServers.has(serverId)) {
      this.metrics.seedRejected += 1;
      return { accepted: false, reason: "server-not-enabled" };
    }
    if (liveOnly && matchStatus) {
      const now = Date.now();
      const prematchOpenAt = Number.isFinite(matchStartMs)
        ? matchStartMs - this.config.prematchOpenWindowMs
        : Number.NaN;
      const allowPrematchUpcoming = matchStatus === "upcoming" && Number.isFinite(prematchOpenAt) && now >= prematchOpenAt;
      const allowLive = matchStatus === "live";
      if (!allowLive && !allowPrematchUpcoming) {
        this.metrics.seedRejected += 1;
        return { accepted: false, reason: "match-not-open" };
      }
    }
    const ingestUrl = this.resolveIngestUrl(payload);
    if (!isHttpUrl(ingestUrl)) {
      this.metrics.seedRejected += 1;
      return { accepted: false, reason: "invalid-ingest-url" };
    }

    const key = `m${matchId}:s${serverId}`;
    let job = this.jobs.get(key);
    if (!job) {
      const workDir = path.join(this.config.workRoot, `m${matchId}`, `s${serverId}`);
      const remotePrefix = `live/m${matchId}/s${serverId}`;
      job = new RepackJob(this, {
        matchId,
        serverId,
        ingestUrl,
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
      });
    } else {
      job.touchSeed(ingestUrl);
    }
    this.metrics.seedAccepted += 1;
    return { accepted: true, reason: "ok", jobKey: key, ingestUrl };
  }

  async stopAll() {
    const jobs = Array.from(this.jobs.values());
    for (const job of jobs) {
      await job.stop();
    }
    this.jobs.clear();
  }

  diag() {
    const jobs = Array.from(this.jobs.values()).map((job) => job.toDiag());
    const perServer = {};
    for (const job of jobs) {
      perServer[String(job.serverId)] = {
        repack_on: job.state === "running" || job.state === "restarting",
        fallback_reason_top: job.consecutiveUploadErrors > 0 ? "upload-errors" : "none",
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
    seedRestartStaleMs: toInt(process.env.REPACK_SEED_RESTART_STALE_MS, 7_000, 3000),
    localRetentionMs: toInt(process.env.REPACK_LOCAL_RETENTION_MS, 8 * 60 * 1000, 30_000),
    remoteRetentionMs: toInt(process.env.REPACK_REMOTE_RETENTION_MS, 8 * 60 * 1000, 30_000),
    liveOnly: toBool(process.env.REPACK_LIVE_ONLY, true),
    prematchOpenWindowMs: prematchOpenWindowMinutes * 60 * 1000,
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
