import {
  UI_SERVER_IDS,
  buildR2PlaylistUrlForSlot,
  getSlotServerIdForUiServer,
  getSlotSourceUrlFromRow,
  isAllowedSourceForSlotServer,
  isValidHttpUrl,
  type SlotServerId,
} from "./server-source-policy";
import type { MatchR2Status, R2ServerState, R2StatusServerEntry } from "./r2-status-types";
import { getRepackSeedRuntimeState } from "./repack-runtime-state";
import type { StreamMode } from "./stream-mode";
import { computeMatchWindowState, getMatchWindowConfig, parseMatchStartMs } from "./match-window";

const DEFAULT_R2_PROBE_TIMEOUT_MS = 2400;
const DEFAULT_SEGMENT_PROBE_TIMEOUT_MS = 3200;
const DEFAULT_SEED_WARMING_WINDOW_MS = 120_000;
const DEFAULT_STALE_SEQUENCE_GUARD_MS = 30_000;
const SEQUENCE_STATE_TTL_MS = 10 * 60 * 1000;

type StreamRowFields = {
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
  match_start?: string | null;
  status_key?: string | null;
};

type SequenceState = {
  sequence: number;
  changedAt: number;
  lastSeenAt: number;
};

type PlaylistProbeResult = {
  state: R2ServerState;
  reason: string;
  segmentProbe: "ok" | "fail";
  mediaSequence: number | null;
  segmentUrl: string | null;
};

const sequenceStateByPlaylist = new Map<string, SequenceState>();
const staleSequenceCountByPlaylist = new Map<string, { count: number; lastSeenAt: number }>();
const finishedSeenAtByMatchSlot = new Map<string, number>();
const segmentFailStateByMatchSlot = new Map<string, { count: number; lastSeenAt: number }>();

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function trimSequenceState(nowMs: number) {
  for (const [key, value] of sequenceStateByPlaylist.entries()) {
    if (nowMs - value.lastSeenAt > SEQUENCE_STATE_TTL_MS) sequenceStateByPlaylist.delete(key);
  }
  for (const [key, value] of staleSequenceCountByPlaylist.entries()) {
    if (nowMs - value.lastSeenAt > SEQUENCE_STATE_TTL_MS) staleSequenceCountByPlaylist.delete(key);
  }
}

function trimEarlyStopState(nowMs: number) {
  for (const [key, seenAt] of finishedSeenAtByMatchSlot.entries()) {
    if (nowMs - seenAt > SEQUENCE_STATE_TTL_MS) finishedSeenAtByMatchSlot.delete(key);
  }
  for (const [key, value] of segmentFailStateByMatchSlot.entries()) {
    if (nowMs - value.lastSeenAt > SEQUENCE_STATE_TTL_MS) segmentFailStateByMatchSlot.delete(key);
  }
}

function noteSegmentProbeFailure(matchSlotKey: string, failed: boolean, nowMs: number) {
  trimEarlyStopState(nowMs);
  const prev = segmentFailStateByMatchSlot.get(matchSlotKey) || { count: 0, lastSeenAt: nowMs };
  const next = failed
    ? {
        count: prev.count + 1,
        lastSeenAt: nowMs,
      }
    : {
        count: 0,
        lastSeenAt: nowMs,
      };
  segmentFailStateByMatchSlot.set(matchSlotKey, next);
  return next.count;
}

function clearEarlyStopState(matchSlotKey: string) {
  finishedSeenAtByMatchSlot.delete(matchSlotKey);
  segmentFailStateByMatchSlot.delete(matchSlotKey);
}

function parseMediaSequence(playlistBody: string) {
  const match = String(playlistBody || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  if (!match?.[1]) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parseLastSegmentUrl(playlistUrl: string, playlistBody: string) {
  const lines = String(playlistBody || "").split(/\r?\n/);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const raw = String(lines[idx] || "").trim();
    if (!raw || raw.startsWith("#")) continue;
    try {
      const absolute = new URL(raw, playlistUrl).toString();
      if (isValidHttpUrl(absolute)) return absolute;
    } catch {}
  }
  return null;
}

async function probeSegmentUrl(segmentUrl: string, timeoutMs: number) {
  const runTimedFetch = async (method: "HEAD" | "GET", headers?: HeadersInit) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(segmentUrl, {
        method,
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const head = await runTimedFetch("HEAD");
      if (head.ok) return { ok: true, reason: "r2-segment-ok" };
      if (head.status === 405 || head.status === 403 || head.status === 401) {
        const getResp = await runTimedFetch("GET", { range: "bytes=0-1" });
        if (getResp.ok || getResp.status === 206) return { ok: true, reason: "r2-segment-ok" };
        if (attempt === 0 && (getResp.status >= 500 || getResp.status === 429)) continue;
        return { ok: false, reason: `r2-segment-http-${getResp.status}` };
      }
      if (attempt === 0 && (head.status >= 500 || head.status === 429)) continue;
      return { ok: false, reason: `r2-segment-http-${head.status}` };
    } catch {
      if (attempt === 0) continue;
      return { ok: false, reason: "r2-segment-fetch-failed" };
    }
  }
  return { ok: false, reason: "r2-segment-fetch-failed" };
}

function noteSequenceAndGetAgeMs(playlistUrl: string, mediaSequence: number | null, nowMs: number) {
  if (!Number.isFinite(mediaSequence) || mediaSequence === null) return null;
  trimSequenceState(nowMs);
  const key = String(playlistUrl || "").trim();
  if (!key) return null;
  const prev = sequenceStateByPlaylist.get(key);
  if (!prev || prev.sequence !== mediaSequence) {
    sequenceStateByPlaylist.set(key, {
      sequence: mediaSequence,
      changedAt: nowMs,
      lastSeenAt: nowMs,
    });
    return 0;
  }
  prev.lastSeenAt = nowMs;
  sequenceStateByPlaylist.set(key, prev);
  return Math.max(0, nowMs - prev.changedAt);
}

function noteStaleSequenceCount(playlistUrl: string, isStale: boolean, nowMs: number) {
  trimSequenceState(nowMs);
  const key = String(playlistUrl || "").trim();
  if (!key) return 0;
  const prev = staleSequenceCountByPlaylist.get(key) || { count: 0, lastSeenAt: nowMs };
  const next = isStale
    ? { count: prev.count + 1, lastSeenAt: nowMs }
    : { count: 0, lastSeenAt: nowMs };
  staleSequenceCountByPlaylist.set(key, next);
  return next.count;
}

async function probeR2Playlist(playlistUrl: string, timeoutMs: number): Promise<PlaylistProbeResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(playlistUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
      },
    });
    if (!response.ok) {
      return {
        state: "down",
        reason: `r2-http-${response.status}`,
        segmentProbe: "fail",
        mediaSequence: null,
        segmentUrl: null,
      };
    }
    const body = await response.text();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const looksLikeM3u8 =
      body.includes("#EXTM3U") ||
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegurl");
    if (!looksLikeM3u8) {
      return {
        state: "down",
        reason: "r2-non-m3u8",
        segmentProbe: "fail",
        mediaSequence: null,
        segmentUrl: null,
      };
    }
    const segmentUrl = parseLastSegmentUrl(playlistUrl, body);
    if (!segmentUrl) {
      return {
        state: "down",
        reason: "r2-empty-playlist",
        segmentProbe: "fail",
        mediaSequence: parseMediaSequence(body),
        segmentUrl: null,
      };
    }
    const segmentProbe = await probeSegmentUrl(segmentUrl, Math.max(600, Math.floor(timeoutMs * 0.8)));
    if (!segmentProbe.ok) {
      return {
        state: "down",
        reason: segmentProbe.reason,
        segmentProbe: "fail",
        mediaSequence: parseMediaSequence(body),
        segmentUrl,
      };
    }
    return {
      state: "ready",
      reason: "r2-ready",
      segmentProbe: "ok",
      mediaSequence: parseMediaSequence(body),
      segmentUrl,
    };
  } catch {
    return {
      state: "down",
      reason: "r2-fetch-failed",
      segmentProbe: "fail",
      mediaSequence: null,
      segmentUrl: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveStateFromRecentSeed(matchId: number, slotServer: SlotServerId, probeReason: string, nowMs: number) {
  const seedState = getRepackSeedRuntimeState(matchId, slotServer);
  if (!seedState) {
    return {
      state: "down" as R2ServerState,
      reason: probeReason,
      resolverState: "unknown" as const,
      resolveReason: probeReason,
    };
  }
  if (nowMs - seedState.updatedAt > DEFAULT_SEED_WARMING_WINDOW_MS) {
    return {
      state: "down" as R2ServerState,
      reason: probeReason,
      resolverState: "unknown" as const,
      resolveReason: probeReason,
    };
  }
  if (seedState.accepted) {
    return {
      state: "warming" as R2ServerState,
      reason: `seed-accepted:${seedState.reason || "ok"}:${probeReason}`,
      resolverState: seedState.resolverState || ("ok" as const),
      resolveReason: seedState.resolveReason || "seed-accepted",
    };
  }
  return {
    state: "down" as R2ServerState,
    reason: `seed-rejected:${seedState.reason || probeReason}`,
    resolverState: seedState.resolverState || ("unknown" as const),
    resolveReason: seedState.resolveReason || seedState.reason || probeReason,
  };
}

export async function buildMatchR2Status(input: {
  mode: StreamMode;
  matchId: number;
  row: StreamRowFields;
  repackBaseUrl: string;
  probeTimeoutMs?: number;
}) {
  const mode = input.mode;
  const matchId = Number.parseInt(String(input.matchId || 0), 10);
  const nowMs = Date.now();
  const statusKey = String(input.row.status_key || "").trim().toLowerCase();
  const matchWindowConfig = getMatchWindowConfig();
  const matchStartMs = parseMatchStartMs(input.row.match_start);
  const matchWindow = computeMatchWindowState({
    matchStartMs,
    nowMs,
    config: matchWindowConfig,
  });
  const shouldEarlyStopFinished = matchWindowConfig.earlyStopOnFinished && statusKey === "finished";
  const finishedDebounceMs = Math.max(0, matchWindowConfig.finishedDebounceMinutes * 60 * 1000);
  const probeTimeoutMs = Math.max(600, Number.parseInt(String(input.probeTimeoutMs || DEFAULT_R2_PROBE_TIMEOUT_MS), 10));
  const segmentProbeTimeoutMs = Math.max(
    600,
    Number.parseInt(String(process.env.R2_STATUS_SEGMENT_PROBE_TIMEOUT_MS || DEFAULT_SEGMENT_PROBE_TIMEOUT_MS), 10)
  );
  const staleSequenceGuardMs = Math.max(
    3000,
    Number.parseInt(String(process.env.R2_STATUS_STALE_SEQUENCE_GUARD_MS || DEFAULT_STALE_SEQUENCE_GUARD_MS), 10)
  );
  const shouldProbeR2 = mode === "r2_strict";
  trimEarlyStopState(nowMs);

  const servers = await Promise.all(
    UI_SERVER_IDS.map(async (uiServer): Promise<R2StatusServerEntry> => {
      const slotServer = getSlotServerIdForUiServer(uiServer);
      const matchSlotKey = `m${matchId}:s${slotServer}`;
      const sourceUrl = getSlotSourceUrlFromRow(input.row, slotServer) || "";
      const hasSource = isValidHttpUrl(sourceUrl);
      const sourceAllowed = hasSource ? isAllowedSourceForSlotServer(slotServer, sourceUrl) : false;
      const playlistUrl = buildR2PlaylistUrlForSlot(input.repackBaseUrl, matchId, slotServer);
      if (!hasSource || !sourceAllowed || !playlistUrl) {
        clearEarlyStopState(matchSlotKey);
        return {
          uiServer,
          slotServer,
          state: "down",
          playlistUrl,
          segmentProbe: "unknown",
          lastSequenceAgeMs: null,
          resolverState: !hasSource ? "missing-source" : "unknown",
          resolveReason: !hasSource ? "missing-source" : !sourceAllowed ? "source-not-allowed" : "invalid-match-id",
          reason: !hasSource ? "missing-source" : !sourceAllowed ? "source-not-allowed" : "invalid-match-id",
          updatedAt: nowIso(nowMs),
        };
      }

      if (!shouldProbeR2) {
        clearEarlyStopState(matchSlotKey);
        return {
          uiServer,
          slotServer,
          state: "ready",
          playlistUrl,
          segmentProbe: "unknown",
          lastSequenceAgeMs: null,
          resolverState: "ok",
          resolveReason: "legacy-mode",
          reason: "legacy-mode",
          updatedAt: nowIso(nowMs),
        };
      }

      if (!matchWindow.inWindow) {
        clearEarlyStopState(matchSlotKey);
        return {
          uiServer,
          slotServer,
          state: "down",
          playlistUrl,
          segmentProbe: "unknown",
          lastSequenceAgeMs: null,
          resolverState: "unknown",
          resolveReason: "blocked-outside-window",
          reason: "blocked-outside-window",
          updatedAt: nowIso(nowMs),
        };
      }

      let finishedSeenAt: number | null = null;
      if (shouldEarlyStopFinished) {
        const existingSeenAt = finishedSeenAtByMatchSlot.get(matchSlotKey);
        finishedSeenAt = Number.isFinite(existingSeenAt) ? Number(existingSeenAt) : nowMs;
        if (!Number.isFinite(existingSeenAt)) {
          finishedSeenAtByMatchSlot.set(matchSlotKey, finishedSeenAt);
        }
      } else {
        finishedSeenAtByMatchSlot.delete(matchSlotKey);
      }

      const probed = await probeR2Playlist(playlistUrl, Math.max(probeTimeoutMs, segmentProbeTimeoutMs));
      const sequenceAgeMs = noteSequenceAndGetAgeMs(playlistUrl, probed.mediaSequence, nowMs);
      const consecutiveSegmentFails = noteSegmentProbeFailure(matchSlotKey, probed.segmentProbe === "fail", nowMs);
      const recentSeedState = getRepackSeedRuntimeState(matchId, slotServer);
      const recentSeedRejected =
        !!recentSeedState &&
        !recentSeedState.accepted &&
        nowMs - recentSeedState.updatedAt <= DEFAULT_SEED_WARMING_WINDOW_MS;
      if (recentSeedRejected) {
        return {
          uiServer,
          slotServer,
          state: "down",
          playlistUrl,
          segmentProbe: probed.segmentProbe,
          lastSequenceAgeMs: sequenceAgeMs,
          resolverState: recentSeedState?.resolverState || "unknown",
          resolveReason: recentSeedState?.resolveReason || recentSeedState?.reason || "seed-rejected",
          reason: `seed-rejected:${recentSeedState?.reason || "unknown"}`,
          updatedAt: nowIso(nowMs),
        };
      }
      const finishedDebounced =
        shouldEarlyStopFinished &&
        finishedSeenAt !== null &&
        nowMs - finishedSeenAt >= finishedDebounceMs;
      if (finishedDebounced && consecutiveSegmentFails >= matchWindowConfig.earlyStopSegmentFailStreak) {
        return {
          uiServer,
          slotServer,
          state: "down",
          playlistUrl,
          segmentProbe: probed.segmentProbe,
          lastSequenceAgeMs: sequenceAgeMs,
          resolverState: "probe-failed",
          resolveReason: "early-stop-finished+segment-fail",
          reason: "early-stop-finished+segment-fail",
          updatedAt: nowIso(nowMs),
        };
      }
      const isStaleSequence =
        probed.state === "ready" &&
        Number.isFinite(sequenceAgeMs) &&
        sequenceAgeMs !== null &&
        sequenceAgeMs > staleSequenceGuardMs;
      const staleSequenceCount = noteStaleSequenceCount(playlistUrl, isStaleSequence, nowMs);
      const staleSequenceConfirmed = isStaleSequence && staleSequenceCount >= 2;
      if (probed.state === "ready" && !staleSequenceConfirmed) {
        return {
          uiServer,
          slotServer,
          state: "ready",
          playlistUrl,
          segmentProbe: "ok",
          lastSequenceAgeMs: sequenceAgeMs,
          resolverState: "ok",
          resolveReason: "ok",
          reason: probed.reason,
          updatedAt: nowIso(nowMs),
        };
      }

      const fallbackReason = staleSequenceConfirmed ? "r2-sequence-stale" : probed.reason;
      const seeded = resolveStateFromRecentSeed(matchId, slotServer, fallbackReason, nowMs);
      const fallbackResolverState =
        seeded.resolverState === "unknown" && probed.segmentProbe === "fail"
          ? "probe-failed"
          : seeded.resolverState;
      const fallbackResolveReason =
        seeded.resolverState === "unknown" && probed.segmentProbe === "fail"
          ? probed.reason
          : seeded.resolveReason;
      return {
        uiServer,
        slotServer,
        state: seeded.state,
        playlistUrl,
        segmentProbe: staleSequenceConfirmed ? "ok" : probed.segmentProbe,
        lastSequenceAgeMs: sequenceAgeMs,
        resolverState: fallbackResolverState,
        resolveReason: fallbackResolveReason,
        reason: staleSequenceConfirmed ? `${seeded.reason}:age=${sequenceAgeMs}` : seeded.reason,
        updatedAt: nowIso(nowMs),
      };
    })
  );

  const status: MatchR2Status = {
    mode,
    servers,
    updatedAt: nowIso(nowMs),
  };
  return status;
}
