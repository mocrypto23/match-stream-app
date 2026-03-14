import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  resolveSessionBackedManifest,
  type RuntimeAdapter,
} from "./shared";

export const defaultRuntimeAdapter: RuntimeAdapter = {
  kind: "default",
  matches: () => true,
  resolve: async (input) =>
    resolveSessionBackedManifest(input, {
      adapterKind: "default",
      candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
      maxCandidatesToTry: 5,
      preferUrlIncludes: [".m3u8", "/manifest/", "/playlist/", "/stream/", "/hls/", "/live/"],
      preferReferrerIncludes: [],
      preferManifestIncludes: ["#extm3u", "#extinf"],
    }),
};
