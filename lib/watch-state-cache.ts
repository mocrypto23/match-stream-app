import type { LivekoraMatchRow } from "@/lib/livekora-match";
import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { beinliveProvider } from "@/lib/beinlive-provider";
import { livekoraProvider } from "@/lib/live-providers";
import { siiirProvider } from "@/lib/siiir-provider";
import type { StreamProviderId } from "@/lib/stream-source-types";
import { resolveProviderSourceUrl } from "@/lib/stream-provider-registry";
import { yallashootProvider } from "@/lib/yallashoot-provider";

type SourceUrlMap = Record<StreamProviderId, string | null>;

export type HotWatchStateSeed = {
  matchId: number;
  sourceUrls: SourceUrlMap;
  matchStart: string | null;
  statusKey: string | null;
  seededAt: number;
  updatedAt: string;
};

const HOT_WATCH_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const hotWatchStateSeedCache = new Map<number, HotWatchStateSeed>();
const hotWatchStateSeedInflight = new Map<number, Promise<{ seed: HotWatchStateSeed | null; row: LivekoraMatchRow | null; error: Error | null }>>();

function normalizeSourceUrl(value: string | null | undefined) {
  return String(value || "").trim() || null;
}

function sourceUrlMapFromResolved(input: {
  livekora: string | null;
  beinlive: string | null;
  siiir: string | null;
  yallashoot: string | null;
}): SourceUrlMap {
  return {
    livekora: normalizeSourceUrl(input.livekora),
    beinlive: normalizeSourceUrl(input.beinlive),
    siiir: normalizeSourceUrl(input.siiir),
    yallashoot: normalizeSourceUrl(input.yallashoot),
  };
}

function pruneExpiredSeeds(now: number) {
  for (const [matchId, seed] of hotWatchStateSeedCache.entries()) {
    if (now - seed.seededAt > HOT_WATCH_STATE_TTL_MS) {
      hotWatchStateSeedCache.delete(matchId);
    }
  }
}

export function seedHotWatchState(input: {
  matchId: number;
  livekoraSourceUrl?: string | null;
  beinliveSourceUrl?: string | null;
  siiirSourceUrl?: string | null;
  yallashootSourceUrl?: string | null;
  matchStart?: string | null;
  statusKey?: string | null;
}) {
  const now = Date.now();
  pruneExpiredSeeds(now);
  const current = hotWatchStateSeedCache.get(input.matchId);
  const sourceUrls = sourceUrlMapFromResolved({
    livekora: input.livekoraSourceUrl ?? current?.sourceUrls.livekora ?? null,
    beinlive: input.beinliveSourceUrl ?? current?.sourceUrls.beinlive ?? null,
    siiir: input.siiirSourceUrl ?? current?.sourceUrls.siiir ?? null,
    yallashoot: input.yallashootSourceUrl ?? current?.sourceUrls.yallashoot ?? null,
  });
  const next: HotWatchStateSeed = {
    matchId: input.matchId,
    sourceUrls,
    matchStart: input.matchStart ?? current?.matchStart ?? null,
    statusKey: input.statusKey ?? current?.statusKey ?? null,
    seededAt: now,
    updatedAt: new Date(now).toISOString(),
  };
  hotWatchStateSeedCache.set(input.matchId, next);
  return next;
}

export function getHotWatchStateSeed(matchId: number) {
  const now = Date.now();
  const cached = hotWatchStateSeedCache.get(matchId);
  if (!cached) return null;
  if (now - cached.seededAt > HOT_WATCH_STATE_TTL_MS) {
    hotWatchStateSeedCache.delete(matchId);
    return null;
  }
  return cached;
}

async function resolveSourceUrls(row: LivekoraMatchRow) {
  const [livekoraSourceUrl, beinliveSourceUrl, siiirSourceUrl, yallashootSourceUrl] = await Promise.all([
    resolveProviderSourceUrl(livekoraProvider, row),
    resolveProviderSourceUrl(beinliveProvider, row),
    resolveProviderSourceUrl(siiirProvider, row),
    resolveProviderSourceUrl(yallashootProvider, row),
  ]);
  return sourceUrlMapFromResolved({
    livekora: livekoraSourceUrl,
    beinlive: beinliveSourceUrl,
    siiir: siiirSourceUrl,
    yallashoot: yallashootSourceUrl,
  });
}

export async function loadAndSeedHotWatchState(matchId: number) {
  const { data, error } = await fetchLivekoraMatchRow(matchId);
  if (error) return { seed: null as HotWatchStateSeed | null, row: null as LivekoraMatchRow | null, error };
  if (!data) return { seed: null as HotWatchStateSeed | null, row: null as LivekoraMatchRow | null, error: null };
  const sourceUrls = await resolveSourceUrls(data);
  const seed = seedHotWatchState({
    matchId,
    livekoraSourceUrl: sourceUrls.livekora,
    beinliveSourceUrl: sourceUrls.beinlive,
    siiirSourceUrl: sourceUrls.siiir,
    yallashootSourceUrl: sourceUrls.yallashoot,
    matchStart: data.match_start || null,
    statusKey: data.status_key || null,
  });
  return { seed, row: data, error: null };
}

export async function getOrLoadHotWatchStateSeed(matchId: number) {
  const cached = getHotWatchStateSeed(matchId);
  if (cached) return { seed: cached, row: null as LivekoraMatchRow | null, error: null };
  const existing = hotWatchStateSeedInflight.get(matchId);
  if (existing) return await existing;
  const promise = loadAndSeedHotWatchState(matchId);
  hotWatchStateSeedInflight.set(matchId, promise);
  try {
    return await promise;
  } finally {
    if (hotWatchStateSeedInflight.get(matchId) === promise) {
      hotWatchStateSeedInflight.delete(matchId);
    }
  }
}
