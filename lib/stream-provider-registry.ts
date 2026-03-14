import { beinliveProvider } from "@/lib/beinlive-provider";
import { livekoraProvider, type LiveStreamProvider, type MatchRowLike } from "@/lib/live-providers";
import type { StreamProviderId } from "@/lib/stream-source-types";

export const streamProviders = [livekoraProvider, beinliveProvider] as const;

export function getStreamProvider(providerId: StreamProviderId) {
  return streamProviders.find((provider) => provider.id === providerId) || null;
}

export async function resolveProviderSourceUrl(provider: LiveStreamProvider, row: MatchRowLike) {
  const resolved = await provider.sourceSelector(row);
  const value = String(resolved || "").trim();
  return value || null;
}
