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

const DEFAULT_R2_PROBE_TIMEOUT_MS = 2400;
const DEFAULT_SEGMENT_PROBE_TIMEOUT_MS = 1700;
const DEFAULT_SEED_WARMING_WINDOW_MS = 120_000;
const DEFAULT_STALE_SEQUENCE_GUARD_MS = 12_000;
const SEQUENCE_STATE_TTL_MS = 10 * 60 * 1000;

type StreamRowFields = {
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
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

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function trimSequenceState(nowMs: number) {
  for (const [key, value] of sequenceStateByPlaylist.entries()) {
    if (nowMs - value.lastSeenAt > SEQUENCE_STATE_TTL_MS) sequenceStateByPlaylist.delete(key);
  }
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetch(segmentUrl, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (head.ok) return { ok: true, reason: "r2-segment-ok" };
    if (head.status !== 405) {
      return { ok: false, reason: `r2-segment-http-${head.status}` };
    }
    const getResp = await fetch(segmentUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        range: "bytes=0-1",
      },
    });
    if (getResp.ok || getResp.status === 206) return { ok: true, reason: "r2-segment-ok" };
    return { ok: false, reason: `r2-segment-http-${getResp.status}` };
  } catch {
    return { ok: false, reason: "r2-segment-fetch-failed" };
  } finally {
    clearTimeout(timeoutId);
  }
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
    return { state: "down" as R2ServerState, reason: probeReason };
  }
  if (nowMs - seedState.updatedAt > DEFAULT_SEED_WARMING_WINDOW_MS) {
    return { state: "down" as R2ServerState, reason: probeReason };
  }
  if (seedState.accepted) {
    return {
      state: "warming" as R2ServerState,
      reason: `seed-accepted:${seedState.reason || "ok"}`,
    };
  }
  return {
    state: "down" as R2ServerState,
    reason: `seed-rejected:${seedState.reason || probeReason}`,
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

  const servers = await Promise.all(
    UI_SERVER_IDS.map(async (uiServer): Promise<R2StatusServerEntry> => {
      const slotServer = getSlotServerIdForUiServer(uiServer);
      const sourceUrl = getSlotSourceUrlFromRow(input.row, slotServer) || "";
      const hasSource = isValidHttpUrl(sourceUrl);
      const sourceAllowed = hasSource ? isAllowedSourceForSlotServer(slotServer, sourceUrl) : false;
      const playlistUrl = buildR2PlaylistUrlForSlot(input.repackBaseUrl, matchId, slotServer);
      if (!hasSource || !sourceAllowed || !playlistUrl) {
        return {
          uiServer,
          slotServer,
          state: "down",
          playlistUrl,
          segmentProbe: "unknown",
          lastSequenceAgeMs: null,
          reason: !hasSource ? "missing-source" : !sourceAllowed ? "source-not-allowed" : "invalid-match-id",
          updatedAt: nowIso(nowMs),
        };
      }

      if (!shouldProbeR2) {
        return {
          uiServer,
          slotServer,
          state: "ready",
          playlistUrl,
          segmentProbe: "unknown",
          lastSequenceAgeMs: null,
          reason: "legacy-mode",
          updatedAt: nowIso(nowMs),
        };
      }

      const probed = await probeR2Playlist(playlistUrl, Math.max(probeTimeoutMs, segmentProbeTimeoutMs));
      const sequenceAgeMs = noteSequenceAndGetAgeMs(playlistUrl, probed.mediaSequence, nowMs);
      const isStaleSequence =
        probed.state === "ready" &&
        Number.isFinite(sequenceAgeMs) &&
        sequenceAgeMs !== null &&
        sequenceAgeMs > staleSequenceGuardMs;
      if (probed.state === "ready" && !isStaleSequence) {
        return {
          uiServer,
          slotServer,
          state: "ready",
          playlistUrl,
          segmentProbe: "ok",
          lastSequenceAgeMs: sequenceAgeMs,
          reason: probed.reason,
          updatedAt: nowIso(nowMs),
        };
      }

      const fallbackReason = isStaleSequence ? "r2-sequence-stale" : probed.reason;
      const seeded = resolveStateFromRecentSeed(matchId, slotServer, fallbackReason, nowMs);
      return {
        uiServer,
        slotServer,
        state: seeded.state,
        playlistUrl,
        segmentProbe: "fail",
        lastSequenceAgeMs: sequenceAgeMs,
        reason: isStaleSequence ? `${seeded.reason}:age=${sequenceAgeMs}` : seeded.reason,
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
