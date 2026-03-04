export type MatchWindowConfig = {
  prematchOpenMinutes: number;
  matchDurationMinutes: number;
  postmatchGraceMinutes: number;
  earlyStopOnFinished: boolean;
  finishedDebounceMinutes: number;
  earlyStopSegmentFailStreak: number;
};

export type MatchWindowState = {
  hasStart: boolean;
  startAtMs: number | null;
  openAtMs: number | null;
  closeAtMs: number | null;
  inWindow: boolean;
};

function parseIntWithMin(raw: unknown, fallback: number, min: number) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function parseBool(raw: unknown, fallback: boolean) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return fallback;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

function pick(...values: Array<unknown>) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

export function getMatchWindowConfig(env = process.env): MatchWindowConfig {
  return {
    prematchOpenMinutes: parseIntWithMin(
      pick(env.NEXT_PUBLIC_PREMATCH_OPEN_WINDOW_MINUTES, env.REPACK_PREMATCH_OPEN_WINDOW_MINUTES, "30"),
      30,
      0
    ),
    matchDurationMinutes: parseIntWithMin(
      pick(env.NEXT_PUBLIC_MATCH_DURATION_MINUTES, env.REPACK_MATCH_DURATION_MINUTES, "180"),
      180,
      1
    ),
    postmatchGraceMinutes: parseIntWithMin(
      pick(env.NEXT_PUBLIC_POSTMATCH_GRACE_MINUTES, env.REPACK_POSTMATCH_GRACE_MINUTES, "15"),
      15,
      0
    ),
    earlyStopOnFinished: parseBool(env.REPACK_EARLY_STOP_ON_FINISHED, false),
    finishedDebounceMinutes: parseIntWithMin(env.REPACK_FINISHED_DEBOUNCE_MINUTES, 5, 0),
    earlyStopSegmentFailStreak: parseIntWithMin(env.REPACK_EARLY_STOP_SEGMENT_FAIL_STREAK, 4, 1),
  };
}

export function parseMatchStartMs(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const ms = Number.parseInt(String(new Date(value).getTime()), 10);
  return Number.isFinite(ms) ? ms : null;
}

export function computeMatchWindowState(input: {
  matchStartMs: number | null;
  nowMs?: number;
  config: MatchWindowConfig;
}): MatchWindowState {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const startAtMs = Number.isFinite(input.matchStartMs) ? Number(input.matchStartMs) : null;
  if (!startAtMs) {
    return {
      hasStart: false,
      startAtMs: null,
      openAtMs: null,
      closeAtMs: null,
      inWindow: false,
    };
  }

  const openAtMs = startAtMs - input.config.prematchOpenMinutes * 60 * 1000;
  const closeAtMs =
    startAtMs + (input.config.matchDurationMinutes + input.config.postmatchGraceMinutes) * 60 * 1000;
  return {
    hasStart: true,
    startAtMs,
    openAtMs,
    closeAtMs,
    inWindow: nowMs >= openAtMs && nowMs <= closeAtMs,
  };
}
