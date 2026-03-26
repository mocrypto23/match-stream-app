const inFlightSessionManifestLoads = new Map<string, Promise<unknown>>();

export async function runSessionManifestSingleflight<T>(key: string, loader: () => Promise<T>) {
  const existing = inFlightSessionManifestLoads.get(key) as Promise<T> | undefined;
  if (existing) return await existing;

  const promise = (async () => await loader())();
  inFlightSessionManifestLoads.set(key, promise as Promise<unknown>);
  try {
    return await promise;
  } finally {
    if (inFlightSessionManifestLoads.get(key) === promise) {
      inFlightSessionManifestLoads.delete(key);
    }
  }
}
