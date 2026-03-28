const STREAM_OPEN_LEAD_MS = 30 * 60 * 1000;
const LIVE_LIKE_STATUS_PATTERN =
  /(live|inplay|in-play|started|playing|ongoing|half|1h|2h|extra|pen|penalty|et|overtime)/i;

export type MatchStreamWindow = {
  canOpen: boolean;
  hasKnownKickoff: boolean;
  kickoffAtMs: number | null;
  opensAtMs: number | null;
  msUntilOpen: number;
};

export function getMatchStreamWindow(
  matchStart: string | null | undefined,
  statusKey: string | null | undefined,
  nowMs = Date.now(),
): MatchStreamWindow {
  const kickoffAtMs = matchStart ? new Date(matchStart).getTime() : Number.NaN;
  const normalizedStatusKey = String(statusKey || "").trim();

  if (!Number.isFinite(kickoffAtMs)) {
    return {
      canOpen: true,
      hasKnownKickoff: false,
      kickoffAtMs: null,
      opensAtMs: null,
      msUntilOpen: 0,
    };
  }

  if (LIVE_LIKE_STATUS_PATTERN.test(normalizedStatusKey)) {
    return {
      canOpen: true,
      hasKnownKickoff: true,
      kickoffAtMs,
      opensAtMs: kickoffAtMs - STREAM_OPEN_LEAD_MS,
      msUntilOpen: 0,
    };
  }

  const opensAtMs = kickoffAtMs - STREAM_OPEN_LEAD_MS;
  const canOpen = nowMs >= opensAtMs;
  return {
    canOpen,
    hasKnownKickoff: true,
    kickoffAtMs,
    opensAtMs,
    msUntilOpen: canOpen ? 0 : Math.max(0, opensAtMs - nowMs),
  };
}

export function getMatchStreamWindowFromSeed(
  seed: { matchStart?: string | null; statusKey?: string | null } | null | undefined,
  nowMs = Date.now(),
) {
  return getMatchStreamWindow(seed?.matchStart, seed?.statusKey, nowMs);
}

