const inflightBootstrapRequests = new Map<string, Promise<unknown>>();

function buildBootstrapKey(provider: string, matchId: number) {
  return `${provider}:${matchId}`;
}

export async function runBootstrapSingleflight<T>(provider: string, matchId: number, factory: () => Promise<T>) {
  const key = buildBootstrapKey(provider, matchId);
  const current = inflightBootstrapRequests.get(key) as Promise<T> | undefined;
  if (current) return await current;

  const next = factory().finally(() => {
    inflightBootstrapRequests.delete(key);
  });
  inflightBootstrapRequests.set(key, next as Promise<unknown>);
  return await next;
}
