import { beinliveProvider } from "@/lib/beinlive-provider";
import { livekoraProvider, type LiveStreamProvider, type MatchRowLike } from "@/lib/live-providers";
import { siiirProvider } from "@/lib/siiir-provider";
import type { StreamProviderId } from "@/lib/stream-source-types";
import { yallashootProvider } from "@/lib/yallashoot-provider";

export const streamProviders = [livekoraProvider, beinliveProvider, siiirProvider, yallashootProvider] as const;

const SOURCE_URL_CACHE_TTL_MS = 2 * 60_000;
const sourceUrlCache = new Map<string, { value: string | null; expiresAt: number }>();
const sourceUrlInflight = new Map<string, Promise<string | null>>();

export function getStreamProvider(providerId: StreamProviderId) {
  return streamProviders.find((provider) => provider.id === providerId) || null;
}

function resolveRowCacheKey(providerId: StreamProviderId, row: MatchRowLike) {
  return [
    providerId,
    String((row as { id?: number | string | null }).id ?? "").trim(),
    String((row as { match_key?: string | null }).match_key ?? "").trim(),
    String(row.home_team || "").trim().toLowerCase(),
    String(row.away_team || "").trim().toLowerCase(),
    String(row.match_start || "").trim(),
  ].join("::");
}

export async function resolveProviderSourceUrl(provider: LiveStreamProvider, row: MatchRowLike) {
  const cacheKey = resolveRowCacheKey(provider.id, row);
  const now = Date.now();
  const cached = sourceUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const existing = sourceUrlInflight.get(cacheKey);
  if (existing) return await existing;

  const promise = (async () => {
    const resolved = await provider.sourceSelector(row);
    const value = String(resolved || "").trim() || null;
    sourceUrlCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + SOURCE_URL_CACHE_TTL_MS,
    });
    return value;
  })();

  sourceUrlInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (sourceUrlInflight.get(cacheKey) === promise) {
      sourceUrlInflight.delete(cacheKey);
    }
  }
}
