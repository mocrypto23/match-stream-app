import { albaRuntimeAdapter } from "@/lib/repack-runtime-adapters/alba";

type MatchRowLike = {
  stream_url_4?: string | null;
};

type ManifestOptions = {
  waitForMediaSequence?: number | null;
  waitTimeoutMs?: number | null;
  forceRefresh?: boolean;
  allowRotate?: boolean;
};

export type ProviderManifestResult = Awaited<ReturnType<typeof albaRuntimeAdapter.currentManifest>>;
export type ProviderAssetResult = Awaited<ReturnType<typeof albaRuntimeAdapter.fetchAsset>>;

export type ProviderContext = {
  matchId: number;
  sourceUrl: string;
  internalOrigin: string;
};

export type LiveStreamProvider = {
  id: "livekora";
  publicPathPrefix: string;
  sourceSelector: (row: MatchRowLike) => string | null;
  isAllowedSource: (rawUrl: string) => boolean;
  extractCurrentManifest: (input: ProviderContext, options?: ManifestOptions) => Promise<ProviderManifestResult>;
  fetchAsset: (
    input: ProviderContext & {
      assetUrl: string;
      referrerUrl?: string | null;
      timeoutMs?: number;
    }
  ) => Promise<ProviderAssetResult>;
};

const LIVEKORA_HOST_SUFFIXES = ["sportsurges.cc", "livekora.vip", "koooralive.click", "kooraxx.com"] as const;
const MANIFEST_RESOLVE_TIMEOUT_MS = 35_000;

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function hostMatchesAnySuffix(host: string, suffixes: readonly string[]) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export function isAllowedLivekoraSource(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    return hostMatchesAnySuffix(new URL(normalized).hostname, LIVEKORA_HOST_SUFFIXES);
  } catch {
    return false;
  }
}

export function pickLivekoraSourceUrl(row: MatchRowLike) {
  const raw = String(row?.stream_url_4 || "").trim();
  return isAllowedLivekoraSource(raw) ? raw : null;
}

export function buildLivekoraPublicPlaylistUrl(matchId: number, publicBaseUrl?: string) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/livekora/m${matchId}/index.m3u8`;
}

export function resolveInternalAppOrigin(req?: Request | null) {
  const configured = String(process.env.LIVEKORA_INTERNAL_APP_ORIGIN || process.env.INTERNAL_APP_ORIGIN || "").trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString().replace(/\/+$/, "");
    } catch {}
  }
  try {
    const origin = new URL(String(req?.url || "")).origin;
    if (origin) return origin.replace(/\/+$/, "");
  } catch {}
  const port = Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
  return `http://127.0.0.1:${port}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorText: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(errorText)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

export function buildLivekoraSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || resolveInternalAppOrigin()).replace(/\/+$/, "")}/api/livekora/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

export const livekoraProvider: LiveStreamProvider = {
  id: "livekora",
  publicPathPrefix: "live/livekora",
  sourceSelector: pickLivekoraSourceUrl,
  isAllowedSource: isAllowedLivekoraSource,
  async extractCurrentManifest(input, options) {
    try {
      return await withTimeout(
        albaRuntimeAdapter.currentManifest(
          {
            sourceUrl: input.sourceUrl,
            slotServer: 4,
            internalOrigin: input.internalOrigin,
          },
          options
        ),
        MANIFEST_RESOLVE_TIMEOUT_MS,
        "livekora-session-timeout"
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "livekora-manifest-failed"),
        playbackUrl: input.sourceUrl,
        currentSource: "",
        mediaSequence: null,
        targetDurationSec: 0,
        refreshed: false,
        rotated: false,
        adapterKind: "alba",
        candidatesFound: 0,
        candidatesTried: 0,
      };
    }
  },
  async fetchAsset(input) {
    try {
      return await albaRuntimeAdapter.fetchAsset({
        sourceUrl: input.sourceUrl,
        slotServer: 4,
        internalOrigin: input.internalOrigin,
        assetUrl: input.assetUrl,
        referrerUrl: input.referrerUrl || undefined,
        timeoutMs: input.timeoutMs,
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        contentType: "",
        bodyBase64: "",
        error: error instanceof Error ? error.message : String(error || "livekora-asset-fetch-failed"),
      };
    }
  },
};

export const liveProviders = [livekoraProvider] as const;
