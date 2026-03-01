export type ProxyAuthMode = "embed-proxy" | "direct";
export type TokenMode = "none" | "upstream";
export type FallbackPolicy = "prefer-repack-with-fallback" | "current-only";
export type RepackProfile = {
  segmentDurationSec: number;
  playlistSize: number;
};

export type ServerCapability = {
  serverId: number;
  repackEligible: boolean;
  p2pEligible: boolean;
  proxyAuthMode: ProxyAuthMode;
  tokenMode: TokenMode;
  fallbackPolicy: FallbackPolicy;
  repackProfile: RepackProfile;
};

const DEFAULT_REPACK_PROFILE: RepackProfile = {
  segmentDurationSec: 4,
  playlistSize: 6,
};

const CAPABILITY_REGISTRY: Record<number, ServerCapability> = {
  1: {
    serverId: 1,
    repackEligible: true,
    p2pEligible: true,
    proxyAuthMode: "embed-proxy",
    tokenMode: "upstream",
    fallbackPolicy: "prefer-repack-with-fallback",
    repackProfile: DEFAULT_REPACK_PROFILE,
  },
  2: {
    serverId: 2,
    repackEligible: true,
    p2pEligible: true,
    proxyAuthMode: "embed-proxy",
    tokenMode: "upstream",
    fallbackPolicy: "prefer-repack-with-fallback",
    repackProfile: DEFAULT_REPACK_PROFILE,
  },
  3: {
    serverId: 3,
    repackEligible: true,
    p2pEligible: true,
    proxyAuthMode: "embed-proxy",
    tokenMode: "upstream",
    fallbackPolicy: "prefer-repack-with-fallback",
    repackProfile: DEFAULT_REPACK_PROFILE,
  },
  4: {
    serverId: 4,
    repackEligible: true,
    p2pEligible: true,
    proxyAuthMode: "embed-proxy",
    tokenMode: "upstream",
    fallbackPolicy: "prefer-repack-with-fallback",
    repackProfile: DEFAULT_REPACK_PROFILE,
  },
  5: {
    serverId: 5,
    repackEligible: false,
    p2pEligible: false,
    proxyAuthMode: "embed-proxy",
    tokenMode: "upstream",
    fallbackPolicy: "current-only",
    repackProfile: DEFAULT_REPACK_PROFILE,
  },
  6: {
    serverId: 6,
    repackEligible: false,
    p2pEligible: false,
    proxyAuthMode: "embed-proxy",
    tokenMode: "upstream",
    fallbackPolicy: "current-only",
    repackProfile: DEFAULT_REPACK_PROFILE,
  },
};

export function getServerCapability(serverId: number) {
  return CAPABILITY_REGISTRY[serverId] || null;
}

export function listServerCapabilities() {
  return Object.values(CAPABILITY_REGISTRY).sort((a, b) => a.serverId - b.serverId);
}

export function getRepackEligibleServerIds() {
  return listServerCapabilities()
    .filter((item) => item.repackEligible)
    .map((item) => item.serverId);
}

export function getP2PEligibleServerIds() {
  return listServerCapabilities()
    .filter((item) => item.p2pEligible)
    .map((item) => item.serverId);
}
