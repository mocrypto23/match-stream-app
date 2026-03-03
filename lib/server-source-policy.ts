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
  4: ["livekora.vip", "koooralive.click", "gomatch-live.com", "kooraxx.com", "sia-bth.net", "baranewssumsel.online"],
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

