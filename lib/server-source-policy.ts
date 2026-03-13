export type UiServerId = 1 | 2 | 3 | 4;
export type SlotServerId = 1 | 2 | 3 | 4;
export type SourceFamily = "bein" | "siiir" | "livehd" | "livekora";

export const UI_SERVER_IDS = [1, 2, 3, 4] as const;
export const SLOT_SERVER_IDS = [1, 2, 3, 4] as const;

const SLOT_BY_UI: Record<UiServerId, SlotServerId> = {
  1: 4,
  2: 2,
  3: 3,
  4: 1,
};

const UI_BY_SLOT: Record<SlotServerId, UiServerId> = {
  1: 4,
  2: 2,
  3: 3,
  4: 1,
};

const SOURCE_FAMILY_BY_SLOT: Record<SlotServerId, SourceFamily> = {
  1: "bein",
  2: "siiir",
  3: "livehd",
  4: "livekora",
};

const HOST_ALLOWLIST_BY_SLOT: Record<SlotServerId, string[]> = {
  1: [
    "bein-live.com",
    "yallashoot2026.com",
    "yallashootttv.com",
    "yallashoot.cv",
    "yallashoooootlive.online",
    "yallashoooootlive.info",
    "yallaliveshoot.online",
    "yallaliveshoot.info",
    "kora-live-live.info",
  ],
  2: ["siiir.tv", "yallashot.us", "aleynoxitram.sbs"],
  3: ["livehd77.pro", "alkoora.live"],
  4: [
    "livekora.vip",
    "koooralive.click",
    "gomatch-live.com",
    "kooraxx.com",
    "sia-bth.net",
    "baranewssumsel.online",
    "sportsurges.cc",
  ],
};

type StreamRowFields = {
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

function normalizeHost(host: string) {
  return String(host || "").trim().toLowerCase().replace(/\.$/, "");
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function extractHost(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    return normalizeHost(new URL(rawUrl).hostname);
  } catch {
    return "";
  }
}

function findSlotServerByHost(hostname: string): SlotServerId | null {
  const host = normalizeHost(hostname);
  if (!host) return null;
  for (const slotServerId of SLOT_SERVER_IDS) {
    if (hostMatchesAnySuffix(host, getSlotHostAllowlist(slotServerId))) return slotServerId;
  }
  return null;
}

function unwrapEmbedProxyTarget(rawUrl: string) {
  let current = String(rawUrl || "").trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isValidHttpUrl(current)) return "";
    try {
      const parsed = new URL(current);
      if (!String(parsed.pathname || "").toLowerCase().includes("/api/embed-proxy")) return parsed.toString();
      const target = safeDecodeURIComponent(String(parsed.searchParams.get("url") || "").trim());
      if (!isValidHttpUrl(target)) return "";
      current = target;
    } catch {
      return "";
    }
  }
  return isValidHttpUrl(current) ? current : "";
}

function extractEmbedProxyReferrer(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const parsed = new URL(rawUrl);
    if (!String(parsed.pathname || "").toLowerCase().includes("/api/embed-proxy")) return "";
    const ref = String(parsed.searchParams.get("ref") || "").trim();
    return isValidHttpUrl(ref) ? ref : "";
  } catch {
    return "";
  }
}

function looksLikeEmbeddedPlayerOrStreamTarget(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    return (
      combined.includes(".m3u8") ||
      pathname.includes("/albaplayer/") ||
      pathname.includes("/playerv2.php") ||
      pathname.includes("/embed") ||
      pathname.includes("/player") ||
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/") ||
      search.includes("token=") ||
      search.includes("sid=") ||
      search.includes("session")
    );
  } catch {
    return false;
  }
}

export function isValidHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function getSlotServerIdForUiServer(uiServerId: UiServerId): SlotServerId {
  return SLOT_BY_UI[uiServerId];
}

export function getUiServerIdForSlotServer(slotServerId: SlotServerId): UiServerId {
  return UI_BY_SLOT[slotServerId];
}

export function getSourceFamilyForSlotServer(slotServerId: SlotServerId): SourceFamily {
  return SOURCE_FAMILY_BY_SLOT[slotServerId];
}

export function getSlotHostAllowlist(slotServerId: SlotServerId) {
  return HOST_ALLOWLIST_BY_SLOT[slotServerId];
}

export function hostMatchesAnySuffix(hostname: string, suffixes: string[]) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return suffixes.some((suffix) => {
    const normalized = normalizeHost(suffix);
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

export function isAllowedSourceForSlotServer(slotServerId: SlotServerId, rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const host = new URL(rawUrl).hostname;
    return hostMatchesAnySuffix(host, getSlotHostAllowlist(slotServerId));
  } catch {
    return false;
  }
}

export function isIngestCandidateAlignedWithSlotServer(input: {
  slotServerId: SlotServerId;
  sourceUrl: string;
  ingestUrl: string;
  probeReferrerUrl?: string | null;
  probePlaylistUrl?: string | null;
}) {
  const { slotServerId } = input;
  const sourceUrl = String(input.sourceUrl || "").trim();
  const ingestUrl = String(input.ingestUrl || "").trim();
  if (!isAllowedSourceForSlotServer(slotServerId, sourceUrl)) return false;
  if (!isValidHttpUrl(ingestUrl)) return false;

  const allowlist = getSlotHostAllowlist(slotServerId);
  const proxyEmbeddedRef = extractEmbedProxyReferrer(ingestUrl);
  if (proxyEmbeddedRef) {
    const proxyRefHost = extractHost(proxyEmbeddedRef);
    if (!proxyRefHost) return false;
    if (!hostMatchesAnySuffix(proxyRefHost, allowlist)) return false;
  }
  const targetUrl = unwrapEmbedProxyTarget(ingestUrl) || ingestUrl;
  const targetHost = extractHost(targetUrl);
  if (!targetHost) return false;

  const referrerPool = [
    String(input.probeReferrerUrl || "").trim(),
    String(input.probePlaylistUrl || "").trim(),
    sourceUrl,
  ].filter((value) => isValidHttpUrl(value));
  const ownReferrers = referrerPool.filter((refUrl) => {
    const refHost = extractHost(refUrl);
    return !!refHost && hostMatchesAnySuffix(refHost, allowlist);
  });
  if (!ownReferrers.length) return false;

  if (hostMatchesAnySuffix(targetHost, allowlist)) return true;

  // Some upstream pages legitimately embed their player chain on a foreign
  // host. If the chain started from an allowed source page for this slot and
  // the target is still a player/stream hop, keep following it.
  if (looksLikeEmbeddedPlayerOrStreamTarget(targetUrl)) return true;

  const targetMappedSlot = findSlotServerByHost(targetHost);
  if (targetMappedSlot && targetMappedSlot !== slotServerId) return false;

  return true;
}

export function getSlotSourceUrlFromRow(row: StreamRowFields, slotServerId: SlotServerId) {
  if (slotServerId === 1) return String(row.stream_url || "").trim() || null;
  if (slotServerId === 2) return String(row.stream_url_2 || "").trim() || null;
  if (slotServerId === 3) return String(row.stream_url_3 || "").trim() || null;
  return String(row.stream_url_4 || "").trim() || null;
}

export function buildR2PlaylistUrlForSlot(baseUrl: string, matchId: number, slotServerId: SlotServerId) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const normalizedBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalizedBase) return null;
  return `${normalizedBase}/m${matchId}/s${slotServerId}/index.m3u8`;
}
