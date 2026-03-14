export type StreamMode = "r2_strict";

export const DEFAULT_STREAM_MODE: StreamMode = "r2_strict";

function normalizeStreamMode(_raw: unknown): StreamMode {
  return "r2_strict";
}

export function getServerStreamMode(env = process.env): StreamMode {
  const explicit = String(env.STREAM_MODE || "").trim();
  if (explicit) return normalizeStreamMode(explicit);
  return normalizeStreamMode(env.NEXT_PUBLIC_STREAM_MODE || DEFAULT_STREAM_MODE);
}

export function getClientStreamMode(env = process.env): StreamMode {
  return normalizeStreamMode(env.NEXT_PUBLIC_STREAM_MODE || DEFAULT_STREAM_MODE);
}

export function isR2StrictMode(mode: StreamMode) {
  return mode === "r2_strict";
}
