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
const DEFAULT_SEED_WARMING_WINDOW_MS = 120_000;

type StreamRowFields = {
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

async function probeR2Playlist(playlistUrl: string, timeoutMs: number) {
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
        state: "down" as R2ServerState,
        reason: `r2-http-${response.status}`,
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
        state: "down" as R2ServerState,
        reason: "r2-non-m3u8",
      };
    }
    return {
      state: "ready" as R2ServerState,
      reason: "r2-ready",
    };
  } catch {
    return {
      state: "down" as R2ServerState,
      reason: "r2-fetch-failed",
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
          reason: "legacy-mode",
          updatedAt: nowIso(nowMs),
        };
      }

      const probed = await probeR2Playlist(playlistUrl, probeTimeoutMs);
      if (probed.state === "ready") {
        return {
          uiServer,
          slotServer,
          state: "ready",
          playlistUrl,
          reason: probed.reason,
          updatedAt: nowIso(nowMs),
        };
      }

      const seeded = resolveStateFromRecentSeed(matchId, slotServer, probed.reason, nowMs);
      return {
        uiServer,
        slotServer,
        state: seeded.state,
        playlistUrl,
        reason: seeded.reason,
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
