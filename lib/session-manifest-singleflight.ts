const inFlightSessionManifestLoads = new Map<string, Promise<unknown>>();
const MAX_PARALLEL_SESSION_MANIFEST_LOADS = Math.max(
  1,
  Number.parseInt(String(process.env.SESSION_MANIFEST_MAX_PARALLEL || "3").trim(), 10) || 3
);

let activeSessionManifestLoads = 0;
const pendingSessionManifestLoadResolvers: Array<() => void> = [];

async function acquireSessionManifestSlot() {
  if (activeSessionManifestLoads < MAX_PARALLEL_SESSION_MANIFEST_LOADS) {
    activeSessionManifestLoads += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    pendingSessionManifestLoadResolvers.push(resolve);
  });
  activeSessionManifestLoads += 1;
}

function releaseSessionManifestSlot() {
  activeSessionManifestLoads = Math.max(0, activeSessionManifestLoads - 1);
  const next = pendingSessionManifestLoadResolvers.shift();
  if (next) next();
}

export async function runSessionManifestSingleflight<T>(key: string, loader: () => Promise<T>) {
  const existing = inFlightSessionManifestLoads.get(key) as Promise<T> | undefined;
  if (existing) return await existing;

  const promise = (async () => {
    await acquireSessionManifestSlot();
    try {
      return await loader();
    } finally {
      releaseSessionManifestSlot();
    }
  })();

  inFlightSessionManifestLoads.set(key, promise as Promise<unknown>);
  try {
    return await promise;
  } finally {
    if (inFlightSessionManifestLoads.get(key) === promise) {
      inFlightSessionManifestLoads.delete(key);
    }
  }
}
