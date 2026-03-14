import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  type RuntimeAdapter,
} from "./shared";

export const defaultRuntimeAdapter: RuntimeAdapter = buildSessionOwnedRuntimeAdapter("default", () => true, {
  adapterKind: "default",
  candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  maxCandidatesToTry: 5,
  readyManifestMaxAgeMs: 12_000,
  warmingRuntimeMaxAgeMs: 22_000,
  warmingProgressMaxAgeMs: 14_000,
  runtimeWatchdogReadyStates: ["healthy"],
  runtimeWatchdogWarmingStates: ["recovering", "refreshing", "stalled"],
  preferUrlIncludes: [".m3u8", "/manifest/", "/playlist/", "/stream/", "/hls/", "/live/"],
  preferReferrerIncludes: [],
  preferManifestIncludes: ["#extm3u", "#extinf"],
});
