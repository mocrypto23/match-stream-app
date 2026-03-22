"use client";

import Hls, { type HlsConfig } from "hls.js";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import VideoPlayerControls from "@/components/VideoPlayerControls";
import type { StreamProviderId, StreamSourcePhase, StreamSourceStatus } from "@/lib/stream-source-types";

type MatchPayload = {
  id: number;
  home_team?: string | null;
  away_team?: string | null;
  home_logo?: string | null;
  away_logo?: string | null;
  match_start?: string | null;
  match_day?: string | null;
  status_key?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_4?: string | null;
  livekoraStatus?: StreamSourceStatus | null;
  livekoraPlaylistUrl?: string | null;
  beinliveStatus?: StreamSourceStatus | null;
  beinlivePlaylistUrl?: string | null;
  siiirStatus?: StreamSourceStatus | null;
  siiirPlaylistUrl?: string | null;
  streamSources?: StreamSourceStatus[] | null;
};

type StatusMap = Record<StreamProviderId, StreamSourceStatus | null>;
type PendingBootstrapMap = Record<StreamProviderId, number>;
type DisplayProgressMap = Record<StreamProviderId, number>;
type DisplayProgressMetaMap = Record<StreamProviderId, { animating: boolean; startedAt: number }>;
type SwarmCloudP2PConfig = {
  live?: boolean;
  logLevel?: boolean | "warn" | "error" | "none";
  trackerZone?: "eu" | "hk" | "us" | "cn";
  hlsjsInstance?: Hls;
  p2pEnabled?: boolean;
  httpLoadTime?: number;
  token?: string;
  channelId?: ((m3u8Url: string) => string) | string;
  swAutoRegister?: boolean;
  swFile?: string;
  swScope?: string;
  sharePlaylist?: boolean;
  getStats?: (
    totalP2PDownloadedKB: number,
    totalP2PUploadedKB: number,
    totalHTTPDownloadedKB: number,
    p2pDownloadSpeed: number,
  ) => void;
  getPeersInfo?: (peers: string[]) => void;
  showSlogan?: boolean;
};
type SwarmCloudEngineInstance = {
  enableP2P: () => void;
  disableP2P: () => void;
  destroy: () => void;
  on: (name: string, listener: (...args: unknown[]) => void) => SwarmCloudEngineInstance;
  off: (name: string, listener: (...args: unknown[]) => void) => SwarmCloudEngineInstance;
};
type SwarmCloudEngineClass = {
  new (config?: SwarmCloudP2PConfig): SwarmCloudEngineInstance;
  tryRegisterServiceWorker: (config?: SwarmCloudP2PConfig) => Promise<void>;
};
type SwarmCloudModule = {
  default: SwarmCloudEngineClass;
};
type P2PStats = {
  enabled: boolean;
  supported: boolean;
  peers: number;
  httpDownloadedBytes: number;
  p2pDownloadedBytes: number;
  uploadedBytes: number;
  ratioPct: number;
  status: string;
};

const STATUS_POLL_MS = 4_000;
const ACTIVE_WARMING_POLL_MS = 1_250;
const AUTO_BOOTSTRAP_RETRY_MS = 12_000;
const ACTIVE_RECOVERY_RETRY_MS = 3_500;
const PLAYBACK_STALL_CHECK_MS = 2_000;
const SOFT_PLAYBACK_STALL_RECOVERY_MS = 2_500;
const HARD_PLAYBACK_STALL_RECOVERY_MS = 9_000;
const WAITING_OVERLAY_DELAY_MS = 3_500;
const PREPARATION_PROGRESS_TICK_MS = 250;
const PREPARATION_PROGRESS_CAP_PCT = 95;
const P2P_STATS_UPDATE_MS = 300;
const P2P_ENABLE_AFTER_STABLE_PLAYBACK_MS = 2_000;
const P2P_MIN_ENABLED_BEFORE_FALLBACK_MS = 1_500;
const SWARMCLOUD_HTTP_LOAD_TIME_MS = 2_000;
const SWARMCLOUD_TRACKER_ZONE: "eu" | "hk" | "us" | "cn" = "eu";
const SWARMCLOUD_TOKEN = "vRC1O25vR";
const SWARMCLOUD_SW_FILE = "/sw.js";
const SWARMCLOUD_SW_SCOPE = "/";
const PROVIDER_META: Array<{ provider: StreamProviderId; order: number; label: string }> = [
  { provider: "livekora", order: 1, label: "livekora vip" },
  { provider: "beinlive", order: 2, label: "bein-live" },
  { provider: "siiir", order: 3, label: "siiir.tv" },
];
const PROVIDER_WARMUP_ESTIMATE_MS: Record<StreamProviderId, number> = {
  livekora: 12_000,
  beinlive: 2_500,
  siiir: 10_000,
};
const EMPTY_P2P_STATS: P2PStats = {
  enabled: false,
  supported: false,
  peers: 0,
  httpDownloadedBytes: 0,
  p2pDownloadedBytes: 0,
  uploadedBytes: 0,
  ratioPct: 0,
  status: "P2P: غير مفعلة",
};
let p2pEngineModulePromise: Promise<SwarmCloudModule> | null = null;

function createPendingBootstrapMap(): PendingBootstrapMap {
  return { livekora: 0, beinlive: 0, siiir: 0 };
}

function createDisplayProgressMap(): DisplayProgressMap {
  return { livekora: 0, beinlive: 0, siiir: 0 };
}

function createDisplayProgressMetaMap(): DisplayProgressMetaMap {
  return {
    livekora: { animating: false, startedAt: 0 },
    beinlive: { animating: false, startedAt: 0 },
    siiir: { animating: false, startedAt: 0 },
  };
}

function loadP2PEngineModule() {
  if (!p2pEngineModulePromise) {
    p2pEngineModulePromise = import("@swarmcloud/hls") as Promise<SwarmCloudModule>;
  }
  return p2pEngineModulePromise;
}

function formatP2PBytes(bytes: number) {
  const safeBytes = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  const kiloBytes = safeBytes / 1024;
  if (kiloBytes < 1024) return `${Math.round(kiloBytes)}KB`;
  const megaBytes = kiloBytes / 1024;
  return `${megaBytes >= 10 ? megaBytes.toFixed(0) : megaBytes.toFixed(1)}MB`;
}

function formatKickoff(value: string | null | undefined) {
  if (!value) return "موعد المباراة غير متوفر";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "موعد المباراة غير متوفر";
  return new Intl.DateTimeFormat("ar-EG", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    timeZone: "Africa/Cairo",
  }).format(date);
}

function stateLabel(status: StreamSourceStatus | null) {
  if (!status) return "جاري التحميل";
  if (status.state === "ready") return "البث جاهز";
  if (String(status.sourceUrl || "").trim() && (status.state === "warming" || status.reason === "not-bootstrapped" || status.phase === "queued")) {
    return "جاري تجهيز البث";
  }
  if (status.state === "warming") return "جاري تجهيز البث";
  return "البث غير جاهز";
}

function stateTone(status: StreamSourceStatus | null) {
  if (!status) return "bg-slate-700";
  if (status.state === "ready") return "bg-emerald-600";
  if (String(status.sourceUrl || "").trim() && (status.state === "warming" || status.reason === "not-bootstrapped" || status.phase === "queued")) {
    return "bg-amber-500";
  }
  if (status.state === "warming") return "bg-amber-500";
  return "bg-rose-600";
}

function progressPct(status: StreamSourceStatus | null) {
  if (!status) return 0;
  if (status.state === "ready") return 100;
  const value = Number(status.progressPct);
  if (!Number.isFinite(value)) return status.reason === "not-bootstrapped" ? 0 : status.state === "warming" ? 8 : 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function phaseLabel(status: StreamSourceStatus | null) {
  const phase = status?.phase as StreamSourcePhase | null | undefined;
  switch (phase) {
    case "queued":
      return "\u062c\u0627\u0631\u064a \u062a\u062c\u0647\u064a\u0632 \u0627\u0644\u0628\u062b";
    case "resolving_source":
      return "\u062c\u0627\u0631\u064a \u0627\u0644\u0648\u0635\u0648\u0644 \u0625\u0644\u0649 \u0627\u0644\u0645\u0635\u062f\u0631";
    case "fetching_manifest":
      return "\u062c\u0627\u0631\u064a \u062a\u062c\u0647\u064a\u0632 \u0627\u0644\u0628\u062b";
    case "resolving_variant":
      return "\u062c\u0627\u0631\u064a \u062a\u062d\u062f\u064a\u062f \u0645\u0633\u0627\u0631 \u0627\u0644\u0628\u062b";
    case "mirroring_assets":
      return "\u062c\u0627\u0631\u064a \u062a\u062c\u0647\u064a\u0632 \u0645\u0642\u0627\u0637\u0639 \u0627\u0644\u0628\u062b";
    case "publishing_playlist":
      return "\u062c\u0627\u0631\u064a \u0646\u0634\u0631 \u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0628\u062b";
    case "ready":
      return "\u0627\u0644\u0628\u062b \u062c\u0627\u0647\u0632";
    case "failed":
      return "\u0641\u0634\u0644 \u062a\u062c\u0647\u064a\u0632 \u0627\u0644\u0645\u0635\u062f\u0631";
    default:
      if (status?.state === "ready") return "\u0627\u0644\u0628\u062b \u062c\u0627\u0647\u0632";
      if (String(status?.sourceUrl || "").trim() && (status?.state === "warming" || status?.reason === "not-bootstrapped" || status?.phase === "queued")) {
        return "\u062c\u0627\u0631\u064a \u062a\u062c\u0647\u064a\u0632 \u0627\u0644\u0628\u062b";
      }
      if (status?.state === "warming") return "\u062c\u0627\u0631\u064a \u062a\u062c\u0647\u064a\u0632 \u0627\u0644\u0628\u062b";
      return "\u0627\u0644\u0645\u0635\u062f\u0631 \u063a\u064a\u0631 \u062c\u0627\u0647\u0632";
  }
}

function progressTone(status: StreamSourceStatus | null) {
  if (!status) return "bg-slate-500";
  if (status.state === "ready") return "bg-emerald-500";
  if (status.state === "warming") return "bg-teal-400";
  return "bg-rose-500";
}

function buildStatusMap(payload: MatchPayload | null): StatusMap {
  return {
    livekora: payload?.livekoraStatus || null,
    beinlive: payload?.beinliveStatus || null,
    siiir: payload?.siiirStatus || null,
  };
}

function phaseProgressFloor(phase: StreamSourcePhase | null | undefined) {
  switch (phase) {
    case "queued":
      return 6;
    case "resolving_source":
      return 18;
    case "fetching_manifest":
      return 32;
    case "resolving_variant":
      return 52;
    case "mirroring_assets":
      return 74;
    case "publishing_playlist":
      return 88;
    case "ready":
      return 100;
    default:
      return 0;
  }
}

function shouldAnimatePreparation(status: StreamSourceStatus | null, hasSource: boolean) {
  if (!hasSource) return false;
  if (status?.state === "ready") return false;
  if (status?.phase && status.phase !== "ready" && status.phase !== "failed") return true;
  if (status?.state === "warming") return true;
  if (status?.reason === "not-bootstrapped") return true;
  return false;
}

function getMatchSourceUrl(payload: MatchPayload | null, provider: StreamProviderId) {
  if (provider === "livekora") return String(payload?.stream_url_4 || "").trim();
  if (provider === "beinlive") return String(payload?.stream_url || "").trim();
  return String(payload?.stream_url_2 || "").trim();
}

function getProviderSourceCandidate(
  payload: MatchPayload | null,
  statuses: StatusMap,
  provider: StreamProviderId
) {
  const status = statuses[provider];
  return String(
    status?.sourceUrl || status?.currentSource || status?.playlistUrl || getMatchSourceUrl(payload, provider)
  ).trim();
}

function providerHasMatch(payload: MatchPayload | null, statuses: StatusMap, provider: StreamProviderId) {
  return !!getProviderSourceCandidate(payload, statuses, provider);
}

function pickInitialProvider(payload: MatchPayload | null) {
  const statuses = buildStatusMap(payload);
  const readyProvider = PROVIDER_META.find(
    (item) => statuses[item.provider]?.state === "ready" && providerHasMatch(payload, statuses, item.provider)
  );
  if (readyProvider) return readyProvider.provider;
  const withSource = PROVIDER_META.find((item) => providerHasMatch(payload, statuses, item.provider));
  if (withSource) return withSource.provider;
  return "livekora" satisfies StreamProviderId;
}

export default function WatchPage() {
  const params = useParams<{ id?: string }>();
  const matchId = Number.parseInt(String(params?.id || "").trim(), 10);
  const [match, setMatch] = useState<MatchPayload | null>(null);
  const [statusByProvider, setStatusByProvider] = useState<StatusMap>({ livekora: null, beinlive: null, siiir: null });
  const [selectedProvider, setSelectedProvider] = useState<StreamProviderId>("livekora");
  const [pageError, setPageError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayProgressByProvider, setDisplayProgressByProvider] = useState<DisplayProgressMap>(createDisplayProgressMap);
  const [retainedPlaylistUrls, setRetainedPlaylistUrls] = useState<Record<StreamProviderId, string>>({
    livekora: "",
    beinlive: "",
    siiir: "",
  });
  const [pendingBootstraps, setPendingBootstraps] = useState<PendingBootstrapMap>(createPendingBootstrapMap);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [playbackStarting, setPlaybackStarting] = useState(false);
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [playerSessionNonce, setPlayerSessionNonce] = useState(0);
  const [p2pStats, setP2pStats] = useState<P2PStats>(EMPTY_P2P_STATS);
  const p2pStatsStoreRef = useRef<Record<string, P2PStats>>({});
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const waitingOverlayTimerRef = useRef<number | null>(null);
  const displayProgressMetaRef = useRef<DisplayProgressMetaMap>(createDisplayProgressMetaMap());
  const hasPlayedRef = useRef(false);
  const selectedRecoveryPendingRef = useRef(false);
  const lastAutoBootstrapAtRef = useRef<Record<StreamProviderId, number>>({
    livekora: 0,
    beinlive: 0,
    siiir: 0,
  });
  const backgroundBootstrapAtRef = useRef<Record<StreamProviderId, number>>({
    livekora: 0,
    beinlive: 0,
    siiir: 0,
  });
  const activeRecoveryAtRef = useRef<Record<StreamProviderId, number>>({
    livekora: 0,
    beinlive: 0,
    siiir: 0,
  });
  const softRecoveryAtRef = useRef<Record<StreamProviderId, number>>({
    livekora: 0,
    beinlive: 0,
    siiir: 0,
  });
  const sourceRecoveryPendingRef = useRef<Record<StreamProviderId, boolean>>({
    livekora: false,
    beinlive: false,
    siiir: false,
  });
  const playbackWatchRef = useRef<{
    provider: StreamProviderId | null;
    streamUrl: string;
    lastTime: number;
    lastAdvanceAt: number;
  }>({
    provider: null,
    streamUrl: "",
    lastTime: 0,
    lastAdvanceAt: 0,
  });
  const p2pControlRef = useRef<{
    enabled: boolean;
    enabledAt: number;
    provider: StreamProviderId | null;
    streamUrl: string;
    disable: (reason?: string) => void;
    scheduleEnable: () => void;
  }>({
    enabled: false,
    enabledAt: 0,
    provider: null,
    streamUrl: "",
    disable: () => {},
    scheduleEnable: () => {},
  });

  const sources = useMemo(
    () =>
      PROVIDER_META.map((item) => statusByProvider[item.provider]).filter(Boolean).sort((left, right) => {
        return Number(left?.order || 0) - Number(right?.order || 0);
      }) as StreamSourceStatus[],
    [statusByProvider]
  );

  const providerHasMatchById = useMemo(
    () => ({
      livekora: providerHasMatch(match, statusByProvider, "livekora"),
      beinlive: providerHasMatch(match, statusByProvider, "beinlive"),
      siiir: providerHasMatch(match, statusByProvider, "siiir"),
    }),
    [match, statusByProvider]
  );

  const activeStatus = useMemo(() => {
    return sources.find((item) => item.provider === selectedProvider) || sources[0] || null;
  }, [selectedProvider, sources]);

  const activeProvider = activeStatus?.provider || selectedProvider;
  const activeProgressPct = progressPct(activeStatus);
  const activePhaseLabel = phaseLabel(activeStatus);
  const fallbackPlaylistUrl = useMemo(() => {
    if (activeProvider === "livekora") {
      const fallback = String(match?.livekoraPlaylistUrl || "").trim();
      return fallback || null;
    }
    if (activeProvider === "beinlive") {
      const fallback = String(match?.beinlivePlaylistUrl || "").trim();
      return fallback || null;
    }
    const fallback = String(match?.siiirPlaylistUrl || "").trim();
    return fallback || null;
  }, [activeProvider, match?.beinlivePlaylistUrl, match?.livekoraPlaylistUrl, match?.siiirPlaylistUrl]);

  const streamUrl = useMemo(() => {
    const retained = String(retainedPlaylistUrls[activeProvider] || "").trim();
    if (activeStatus) {
      const direct =
        activeStatus.state === "ready" ? String(activeStatus.playlistUrl || fallbackPlaylistUrl || "").trim() : "";
      if (direct) return direct;
      return retained || null;
    }
    return retained || fallbackPlaylistUrl;
  }, [activeProvider, activeStatus, fallbackPlaylistUrl, retainedPlaylistUrls]);

  const directSourceUrl = useMemo(() => {
    return getMatchSourceUrl(match, activeProvider) || null;
  }, [activeProvider, match]);
  const providerSourceUrl = useMemo(() => {
    const current = String(activeStatus?.sourceUrl || "").trim();
    if (current) return current;
    return directSourceUrl;
  }, [activeStatus?.sourceUrl, directSourceUrl]);
  const activeDisplayProgressPct = useMemo(() => {
    if (activeStatus?.state === "ready") return 100;
    return Math.max(0, Math.min(100, Math.round(displayProgressByProvider[activeProvider] ?? activeProgressPct)));
  }, [activeProgressPct, activeProvider, activeStatus?.state, displayProgressByProvider]);
  const activePreparationActive = useMemo(() => {
    return shouldAnimatePreparation(activeStatus, !!providerSourceUrl) || (pendingBootstraps[activeProvider] || 0) > 0;
  }, [activeProvider, activeStatus, pendingBootstraps, providerSourceUrl]);
  const p2pStatusLine = useMemo(() => {
    if (!p2pStats.enabled) return p2pStats.status;
    const base = `P2P: ${p2pStats.ratioPct}% | Saved: ${formatP2PBytes(p2pStats.p2pDownloadedBytes)} | Uploaded: ${formatP2PBytes(p2pStats.uploadedBytes)} | Peers: ${p2pStats.peers}`;
    if (p2pStats.peers > 0 || p2pStats.status === "P2P: متصلة") return base;
    return `${base} | ${p2pStats.status.replace(/^P2P:\s*/, "")}`;
  }, [p2pStats]);

  const applyProviderStatus = useCallback((provider: StreamProviderId, status: StreamSourceStatus | null | undefined) => {
    if (!status) return;
    setStatusByProvider((current) => ({
      ...current,
      [provider]: status,
    }));
  }, []);

  const loadMatch = useCallback(async () => {
    if (!Number.isFinite(matchId) || matchId <= 0) {
      setPageError("رقم المباراة غير صالح.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setPageError(null);
    try {
      const response = await fetch(`/api/match/${matchId}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as MatchPayload | { error?: string } | null;
      if (!response.ok || !payload || !("id" in payload)) {
        throw new Error(String((payload as { error?: string } | null)?.error || "match-load-failed"));
      }
      setMatch(payload);
      setStatusByProvider(buildStatusMap(payload));
      setSelectedProvider((current) => {
        const statuses = buildStatusMap(payload);
        if (statuses[current]) return current;
        return pickInitialProvider(payload);
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "تعذر تحميل المباراة.");
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  const refreshProviderStatus = useCallback(
    async (provider: StreamProviderId) => {
      if (!Number.isFinite(matchId) || matchId <= 0) return;
      try {
        const response = await fetch(`/api/${provider}/status?matchId=${encodeURIComponent(String(matchId))}`, {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | { livekoraStatus?: StreamSourceStatus | null; beinliveStatus?: StreamSourceStatus | null; siiirStatus?: StreamSourceStatus | null }
          | null;
        if (!response.ok || !payload) return;
        if (provider === "livekora") applyProviderStatus(provider, payload.livekoraStatus);
        if (provider === "beinlive") applyProviderStatus(provider, payload.beinliveStatus);
        if (provider === "siiir") applyProviderStatus(provider, payload.siiirStatus);
      } catch {}
    },
    [applyProviderStatus, matchId]
  );

  const refreshAllStatuses = useCallback(async () => {
    await Promise.all(PROVIDER_META.map((item) => refreshProviderStatus(item.provider)));
  }, [refreshProviderStatus]);

  const bootstrapProvider = useCallback(
    async (provider: StreamProviderId, opts?: { silent?: boolean }) => {
      if (!Number.isFinite(matchId) || matchId <= 0) return;
      setPendingBootstraps((current) => ({
        ...current,
        [provider]: (current[provider] || 0) + 1,
      }));
      try {
        const response = await fetch(`/api/${provider}/bootstrap`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ matchId }),
        });
        const payload = (await response.json().catch(() => null)) as
          | {
              livekoraStatus?: StreamSourceStatus | null;
              beinliveStatus?: StreamSourceStatus | null;
              siiirStatus?: StreamSourceStatus | null;
              reason?: string;
              error?: string;
            }
          | null;
        if (provider === "livekora") applyProviderStatus(provider, payload?.livekoraStatus);
        if (provider === "beinlive") applyProviderStatus(provider, payload?.beinliveStatus);
        if (provider === "siiir") applyProviderStatus(provider, payload?.siiirStatus);
        if (!response.ok && !opts?.silent) {
          setPageError(String(payload?.reason || payload?.error || "bootstrap-failed"));
        }
      } catch (error) {
        if (!opts?.silent) {
          setPageError(error instanceof Error ? error.message : "bootstrap-failed");
        }
      } finally {
        setPendingBootstraps((current) => ({
          ...current,
          [provider]: Math.max(0, (current[provider] || 0) - 1),
        }));
      }
    },
    [applyProviderStatus, matchId]
  );

  const requestPlaybackStart = useCallback(() => {
    setPageError(null);
    setPlaybackRequested(true);
    setPlaybackStarting(true);
    if (!String(streamUrl || "").trim()) {
      void refreshProviderStatus(activeProvider);
      void bootstrapProvider(activeProvider);
    }
  }, [activeProvider, bootstrapProvider, refreshProviderStatus, streamUrl]);

  const clearWaitingOverlayTimer = useCallback(() => {
    if (waitingOverlayTimerRef.current !== null) {
      window.clearTimeout(waitingOverlayTimerRef.current);
      waitingOverlayTimerRef.current = null;
    }
  }, []);

  const resetPlaybackState = useCallback(
    (opts?: { clearError?: boolean }) => {
      if (opts?.clearError !== false) {
        setPageError(null);
      }
      setPlaybackRequested(false);
      setPlaybackStarting(false);
      setPlaybackStarted(false);
      setPlayerSessionNonce(0);
      setP2pStats(EMPTY_P2P_STATS);
      clearWaitingOverlayTimer();
      hasPlayedRef.current = false;
      selectedRecoveryPendingRef.current = false;
    },
    [clearWaitingOverlayTimer]
  );

  const stopPlaybackSession = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
    }
    resetPlaybackState({ clearError: false });
  }, [resetPlaybackState]);

  useEffect(() => {
    if (providerHasMatchById[selectedProvider]) return;
    const fallbackProvider = PROVIDER_META.find((item) => providerHasMatchById[item.provider])?.provider;
    if (!fallbackProvider || fallbackProvider === selectedProvider) return;
    resetPlaybackState({ clearError: false });
    setSelectedProvider(fallbackProvider);
  }, [providerHasMatchById, resetPlaybackState, selectedProvider]);

  useEffect(() => {
    void loadMatch();
  }, [loadMatch]);

  useEffect(() => {
    resetPlaybackState({ clearError: false });
    backgroundBootstrapAtRef.current = { livekora: 0, beinlive: 0, siiir: 0 };
    lastAutoBootstrapAtRef.current = { livekora: 0, beinlive: 0, siiir: 0 };
    setStatusByProvider({ livekora: null, beinlive: null, siiir: null });
    setDisplayProgressByProvider(createDisplayProgressMap());
    displayProgressMetaRef.current = createDisplayProgressMetaMap();
    setRetainedPlaylistUrls({ livekora: "", beinlive: "", siiir: "" });
    setPendingBootstraps(createPendingBootstrapMap());
    p2pStatsStoreRef.current = {};
    setP2pStats(EMPTY_P2P_STATS);
    setSelectedProvider("livekora");
    activeRecoveryAtRef.current = { livekora: 0, beinlive: 0, siiir: 0 };
    softRecoveryAtRef.current = { livekora: 0, beinlive: 0, siiir: 0 };
    sourceRecoveryPendingRef.current = { livekora: false, beinlive: false, siiir: false };
    selectedRecoveryPendingRef.current = false;
    setPlayerSessionNonce(0);
  }, [matchId, resetPlaybackState]);

  useEffect(() => {
    setRetainedPlaylistUrls((current) => {
      let changed = false;
      const next = { ...current };
      for (const provider of ["livekora", "beinlive", "siiir"] as StreamProviderId[]) {
        const status = statusByProvider[provider];
        const playlistUrl = String(status?.playlistUrl || "").trim();
        if (status?.state === "ready" && playlistUrl && next[provider] !== playlistUrl) {
          next[provider] = playlistUrl;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [statusByProvider]);

  useEffect(() => {
    const tick = () => {
      setDisplayProgressByProvider((current) => {
        const now = Date.now();
        const next = { ...current };
        let changed = false;

        for (const item of PROVIDER_META) {
          const provider = item.provider;
          const status = statusByProvider[provider];
          const hasSource = providerHasMatchById[provider];
          const rawPct = progressPct(status);
          const meta = displayProgressMetaRef.current[provider];
          const animating = shouldAnimatePreparation(status, hasSource);

          if (!hasSource) {
            meta.animating = false;
            meta.startedAt = 0;
            if (next[provider] !== 0) {
              next[provider] = 0;
              changed = true;
            }
            continue;
          }

          if (status?.state === "ready") {
            meta.animating = false;
            meta.startedAt = 0;
            if (next[provider] !== 100) {
              next[provider] = 100;
              changed = true;
            }
            continue;
          }

          if (animating) {
            const startFloor = Math.max(
              phaseProgressFloor(status?.phase),
              rawPct > 0 && rawPct < 100 ? Math.min(rawPct, PREPARATION_PROGRESS_CAP_PCT) : 0
            );
            if (!meta.animating) {
              meta.animating = true;
              meta.startedAt = now;
              if (next[provider] !== startFloor) {
                next[provider] = startFloor;
                changed = true;
              }
            }

            const elapsedMs = Math.max(0, now - meta.startedAt);
            const estimatedMs = Math.max(1_500, PROVIDER_WARMUP_ESTIMATE_MS[provider] || 6_000);
            const elapsedPct = Math.min(
              PREPARATION_PROGRESS_CAP_PCT,
              Math.round((elapsedMs / estimatedMs) * PREPARATION_PROGRESS_CAP_PCT)
            );
            const phaseFloor = phaseProgressFloor(status?.phase);
            const targetPct = Math.max(startFloor, phaseFloor, elapsedPct);
            const nextValue = Math.max(next[provider], Math.min(PREPARATION_PROGRESS_CAP_PCT, targetPct));
            if (nextValue !== next[provider]) {
              next[provider] = nextValue;
              changed = true;
            }
            continue;
          }

          meta.animating = false;
          meta.startedAt = 0;
          const settledPct = rawPct > 0 ? rawPct : 0;
          if (next[provider] !== settledPct) {
            next[provider] = settledPct;
            changed = true;
          }
        }

        return changed ? next : current;
      });
    };

    tick();
    const id = window.setInterval(tick, PREPARATION_PROGRESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [providerHasMatchById, statusByProvider]);

  useEffect(() => {
    return () => {
      clearWaitingOverlayTimer();
    };
  }, [clearWaitingOverlayTimer]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!Hls.isSupported()) return;
    void loadP2PEngineModule().catch(() => null);
  }, []);

  useEffect(() => {
    if (!match) return;
    if (!providerSourceUrl) return;
    void bootstrapProvider(activeProvider, { silent: true });
  }, [activeProvider, bootstrapProvider, match, providerSourceUrl]);

  useEffect(() => {
    if (!match) return;

    let cancelled = false;
    void (async () => {
      const providersToBootstrap = PROVIDER_META.filter((item) => {
        if (item.provider === activeProvider) return false;
        const status = statusByProvider[item.provider];
        if (!providerHasMatch(match, statusByProvider, item.provider)) return false;
        if ((pendingBootstraps[item.provider] || 0) > 0) return false;

        const hasPlaylistUrl = !!String(status?.playlistUrl || "").trim();
        const needsBootstrap =
          !status ||
          status.reason === "not-bootstrapped" ||
          (!hasPlaylistUrl && status.state !== "ready") ||
          (status.state === "down" && !hasPlaylistUrl);
        if (!needsBootstrap) return false;

        const now = Date.now();
        const lastAttemptAt = backgroundBootstrapAtRef.current[item.provider] || 0;
        if (now - lastAttemptAt < AUTO_BOOTSTRAP_RETRY_MS) return false;

        backgroundBootstrapAtRef.current[item.provider] = now;
        return true;
      }).map((item) => item.provider);

      for (const provider of providersToBootstrap) {
        if (cancelled) return;
        await bootstrapProvider(provider, { silent: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProvider, bootstrapProvider, match, pendingBootstraps, statusByProvider]);

  useEffect(() => {
    if (!match) return;
    if (!providerSourceUrl) return;
    if (activeStatus?.reason !== "not-bootstrapped") return;
    if ((pendingBootstraps[activeProvider] || 0) > 0) return;

    const now = Date.now();
    const lastAttemptAt = lastAutoBootstrapAtRef.current[activeProvider] || 0;
    if (now - lastAttemptAt < AUTO_BOOTSTRAP_RETRY_MS) return;

    lastAutoBootstrapAtRef.current[activeProvider] = now;
    void bootstrapProvider(activeProvider, { silent: true });
  }, [
    activeProvider,
    activeStatus?.reason,
    bootstrapProvider,
    match,
    pendingBootstraps,
    providerSourceUrl,
  ]);

  useEffect(() => {
    if (!matchId || Number.isNaN(matchId)) return;
    const id = window.setInterval(() => {
      void refreshAllStatuses();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [matchId, refreshAllStatuses]);

  useEffect(() => {
    if (!matchId || Number.isNaN(matchId)) return;
    if (!providerSourceUrl) return;
    if (!playbackRequested && activeStatus?.state !== "warming") return;
    if (activeStatus?.state === "ready") return;
    const id = window.setInterval(() => {
      void refreshProviderStatus(activeProvider);
    }, ACTIVE_WARMING_POLL_MS);
    return () => window.clearInterval(id);
  }, [activeProvider, activeStatus?.state, matchId, playbackRequested, providerSourceUrl, refreshProviderStatus]);

  useEffect(() => {
    if (!playbackRequested) {
      selectedRecoveryPendingRef.current = false;
      sourceRecoveryPendingRef.current[activeProvider] = false;
      return;
    }
    if (!providerSourceUrl) return;

    const hasUsableStream = !!String(streamUrl || "").trim();
    const isReady = activeStatus?.state === "ready" && hasUsableStream;
    if (!isReady) {
      if (!hasPlayedRef.current || !hasUsableStream) {
        selectedRecoveryPendingRef.current = true;
      }
      if (hasPlayedRef.current) {
        sourceRecoveryPendingRef.current[activeProvider] = true;
      }
      if (hasPlayedRef.current && !hasUsableStream) {
        setPlaybackStarting(true);
      }
      return;
    }

    if (!selectedRecoveryPendingRef.current) return;
    selectedRecoveryPendingRef.current = false;
    setPageError(null);
    setPlaybackStarting(true);
    setPlayerSessionNonce((current) => current + 1);
  }, [activeStatus?.state, playbackRequested, providerSourceUrl, streamUrl]);

  useEffect(() => {
    if (!playbackRequested) return;
    if (!hasPlayedRef.current) return;
    if (!providerSourceUrl) return;
    if (activeStatus?.state !== "ready") return;
    if (!sourceRecoveryPendingRef.current[activeProvider]) return;

    sourceRecoveryPendingRef.current[activeProvider] = false;

    const video = videoRef.current;
    const stream = String(streamUrl || "").trim();
    const now = Date.now();
    const watch = playbackWatchRef.current;
    const stalledForMs = now - watch.lastAdvanceAt;
    const playerLooksStuck =
      !video ||
      video.readyState < 2 ||
      (watch.provider === activeProvider && watch.streamUrl === stream && stalledForMs >= SOFT_PLAYBACK_STALL_RECOVERY_MS);

    if (!playerLooksStuck) return;

    const lastRecoveryAt = activeRecoveryAtRef.current[activeProvider] || 0;
    if (now - lastRecoveryAt < SOFT_PLAYBACK_STALL_RECOVERY_MS) return;

    activeRecoveryAtRef.current[activeProvider] = now;
    selectedRecoveryPendingRef.current = true;
    setPlaybackStarting(true);
    setPlayerSessionNonce((current) => current + 1);
  }, [
    activeProvider,
    activeStatus?.state,
    playbackRequested,
    providerSourceUrl,
    streamUrl,
  ]);

  useEffect(() => {
    const stream = String(streamUrl || "").trim();
    const watch = playbackWatchRef.current;
    const now = Date.now();
    if (!playbackRequested || !stream) {
      playbackWatchRef.current = {
        provider: activeProvider,
        streamUrl: stream,
        lastTime: 0,
        lastAdvanceAt: now,
      };
      return;
    }
    if (watch.provider !== activeProvider || watch.streamUrl !== stream) {
      playbackWatchRef.current = {
        provider: activeProvider,
        streamUrl: stream,
        lastTime: 0,
        lastAdvanceAt: now,
      };
    }
  }, [activeProvider, playbackRequested, streamUrl]);

  useEffect(() => {
    if (!match) return;
    if (!playbackRequested) return;
    if (!providerSourceUrl) return;
    if ((pendingBootstraps[activeProvider] || 0) > 0) return;

    const selectedIsUnavailable = !String(streamUrl || "").trim();
    if (!selectedIsUnavailable) return;

    const now = Date.now();
    const lastAttemptAt = activeRecoveryAtRef.current[activeProvider] || 0;
    if (now - lastAttemptAt < ACTIVE_RECOVERY_RETRY_MS) return;

    activeRecoveryAtRef.current[activeProvider] = now;
    setPlaybackStarting(true);
    void bootstrapProvider(activeProvider, { silent: true });
    void refreshProviderStatus(activeProvider);
  }, [
    activeProvider,
    activeStatus?.state,
    bootstrapProvider,
    match,
    pendingBootstraps,
    playbackRequested,
    providerSourceUrl,
    refreshProviderStatus,
    streamUrl,
  ]);

  useEffect(() => {
    if (!playbackRequested) return;

    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;

      const stream = String(streamUrl || "").trim();
      const now = Date.now();
      const watch = playbackWatchRef.current;
      const currentTime = Number(video.currentTime || 0);
      const providerChanged = watch.provider !== activeProvider;
      const streamChanged = watch.streamUrl !== stream;
      const progressed = currentTime > watch.lastTime + 0.35;

      if (providerChanged || streamChanged) {
        playbackWatchRef.current = {
          provider: activeProvider,
          streamUrl: stream,
          lastTime: currentTime,
          lastAdvanceAt: now,
        };
        return;
      }

      if (progressed) {
        playbackWatchRef.current = {
          provider: activeProvider,
          streamUrl: stream,
          lastTime: currentTime,
          lastAdvanceAt: now,
        };
        return;
      }

      playbackWatchRef.current = {
        provider: activeProvider,
        streamUrl: stream,
        lastTime: currentTime,
        lastAdvanceAt: watch.lastAdvanceAt,
      };

      if (!stream) return;
      if (video.paused) return;

      const stalledForMs = now - playbackWatchRef.current.lastAdvanceAt;
      const selectedUnavailable = !stream;
      const playerSeemsStuck = playbackStarting || video.readyState < 2 || selectedUnavailable;
      if (!playerSeemsStuck) return;

      const hls = hlsRef.current;
      const sourceStillReady = activeStatus?.state === "ready" && !selectedUnavailable;
      const p2pControl = p2pControlRef.current;
      const currentP2PSession =
        p2pControl.enabled &&
        p2pControl.provider === activeProvider &&
        p2pControl.streamUrl === stream;
      if (
        sourceStillReady &&
        currentP2PSession &&
        stalledForMs >= SOFT_PLAYBACK_STALL_RECOVERY_MS &&
        now - p2pControl.enabledAt >= P2P_MIN_ENABLED_BEFORE_FALLBACK_MS
      ) {
        p2pControl.disable("P2P: fallback to R2");
        try {
          hls?.startLoad();
          hls?.recoverMediaError();
        } catch {}
        if (video.paused) {
          void video.play().catch(() => {});
        }
        return;
      }
      const lastSoftRecoveryAt = softRecoveryAtRef.current[activeProvider] || 0;
      if (sourceStillReady && hls && stalledForMs >= SOFT_PLAYBACK_STALL_RECOVERY_MS && now - lastSoftRecoveryAt >= SOFT_PLAYBACK_STALL_RECOVERY_MS) {
        softRecoveryAtRef.current[activeProvider] = now;
        try {
          hls.startLoad();
          hls.recoverMediaError();
        } catch {}
        if (video.paused) {
          void video.play().catch(() => {});
        }
        return;
      }

      const hardRecoveryThresholdMs = sourceStillReady ? HARD_PLAYBACK_STALL_RECOVERY_MS : ACTIVE_RECOVERY_RETRY_MS;
      if (stalledForMs < hardRecoveryThresholdMs) return;

      const lastRecoveryAt = activeRecoveryAtRef.current[activeProvider] || 0;
      if (now - lastRecoveryAt < hardRecoveryThresholdMs) return;

      activeRecoveryAtRef.current[activeProvider] = now;
      selectedRecoveryPendingRef.current = true;
      setPlaybackStarting(true);
      void refreshProviderStatus(activeProvider);
      void bootstrapProvider(activeProvider, { silent: true });
      setPlayerSessionNonce((current) => current + 1);
    }, PLAYBACK_STALL_CHECK_MS);

    return () => window.clearInterval(id);
  }, [
    activeProvider,
    activeStatus?.state,
    bootstrapProvider,
    playbackRequested,
    playbackStarting,
    activeStatus?.state,
    refreshProviderStatus,
    streamUrl,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    const src = String(streamUrl || "").trim();
    const p2pStoreKey = `${matchId}:${activeProvider}`;
    const persistedP2PStats = p2pStatsStoreRef.current[p2pStoreKey];

    clearWaitingOverlayTimer();
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (!video) return;

    video.pause();
    video.removeAttribute("src");
    video.load();
    if (persistedP2PStats?.enabled) {
      setP2pStats(persistedP2PStats);
    } else {
      setP2pStats(EMPTY_P2P_STATS);
    }

    if (!src || !playbackRequested) {
      setPlaybackStarting(false);
      hasPlayedRef.current = false;
      return;
    }

    setPlaybackStarting(true);

    const startPlayback = () => {
      void video.play().catch(() => {});
    };

    const onPlaying = () => {
      clearWaitingOverlayTimer();
      hasPlayedRef.current = true;
      setPlaybackStarted(true);
      setPlaybackStarting(false);
      setPageError(null);
      scheduleEnableP2P();
    };

    const onPlayable = () => {
      if (!playbackRequested) return;
      if (video.readyState < 2) return;
      setPlaybackStarting(false);
    };

    const onWaiting = () => {
      clearWaitingOverlayTimer();
      if (!hasPlayedRef.current) {
        setPlaybackStarting(true);
        return;
      }
      waitingOverlayTimerRef.current = window.setTimeout(() => {
        setPlaybackStarting(true);
        waitingOverlayTimerRef.current = null;
      }, WAITING_OVERLAY_DELAY_MS);
    };

    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        setP2pStats({
          ...EMPTY_P2P_STATS,
          status: "P2P: غير مدعومة على هذا المتصفح",
        });
        video.src = src;
        video.addEventListener("playing", onPlaying);
        video.addEventListener("waiting", onWaiting);
        video.addEventListener("loadeddata", onPlayable);
        video.addEventListener("canplay", onPlayable);
        startPlayback();
        return () => {
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("waiting", onWaiting);
          video.removeEventListener("loadeddata", onPlayable);
          video.removeEventListener("canplay", onPlayable);
        };
      }
      setPlaybackStarting(false);
      setPageError("المتصفح لا يدعم HLS.");
      return;
    }

    let disposed = false;
    let p2pFlushTimer: number | null = null;
    let p2pHeartbeatTimer: number | null = null;
    let p2pEnableTimer: number | null = null;
    let p2pEngine: SwarmCloudEngineInstance | null = null;
    let hls: Hls | null = null;
    const p2pSnapshot: P2PStats = persistedP2PStats?.enabled
      ? { ...persistedP2PStats }
      : {
          enabled: true,
          supported: true,
          peers: 0,
          httpDownloadedBytes: 0,
          p2pDownloadedBytes: 0,
          uploadedBytes: 0,
          ratioPct: 0,
          status: "P2P: waiting for stable playback",
        };
    const clearP2PEnableTimer = () => {
      if (p2pEnableTimer !== null) {
        window.clearTimeout(p2pEnableTimer);
        p2pEnableTimer = null;
      }
    };
    const updateP2PModeStatus = (fallbackReason?: string) => {
      if (disposed || !p2pSnapshot.supported) return;
      if (p2pControlRef.current.enabled) {
        p2pSnapshot.status = p2pSnapshot.peers > 0 ? "P2P: متصلة" : "P2P: جاري البحث عن peers";
        return;
      }
      if (fallbackReason) {
        p2pSnapshot.status = fallbackReason;
        return;
      }
      p2pSnapshot.status = "P2P: waiting for stable playback";
    };
    const updateP2PStats = () => {
      if (disposed) return;
      const totalDownloaded = p2pSnapshot.httpDownloadedBytes + p2pSnapshot.p2pDownloadedBytes;
      p2pSnapshot.ratioPct =
        totalDownloaded > 0 ? Math.max(0, Math.min(100, Math.round((p2pSnapshot.p2pDownloadedBytes / totalDownloaded) * 100))) : 0;
      updateP2PModeStatus();
      const nextStats = { ...p2pSnapshot };
      p2pStatsStoreRef.current[p2pStoreKey] = nextStats;
      setP2pStats(nextStats);
    };
    const scheduleP2PStatsUpdate = () => {
      if (disposed || p2pFlushTimer !== null) return;
      p2pFlushTimer = window.setTimeout(() => {
        p2pFlushTimer = null;
        updateP2PStats();
      }, P2P_STATS_UPDATE_MS);
    };
    const applyP2PMode = (enabled: boolean, fallbackReason?: string) => {
      if (!p2pEngine) return;
      if (enabled) {
        p2pEngine.enableP2P();
      } else {
        p2pEngine.disableP2P();
      }
      p2pControlRef.current.enabled = enabled;
      p2pControlRef.current.enabledAt = enabled ? Date.now() : 0;
      updateP2PModeStatus(fallbackReason);
      scheduleP2PStatsUpdate();
    };
    const scheduleEnableP2P = () => {
      clearP2PEnableTimer();
      if (disposed || !p2pEngine || p2pControlRef.current.enabled) return;
      updateP2PModeStatus();
      scheduleP2PStatsUpdate();
      p2pEnableTimer = window.setTimeout(() => {
        if (disposed || !p2pEngine || p2pControlRef.current.enabled) return;
        applyP2PMode(true);
      }, P2P_ENABLE_AFTER_STABLE_PLAYBACK_MS);
    };
    p2pControlRef.current = {
      enabled: false,
      enabledAt: 0,
      provider: activeProvider,
      streamUrl: src,
      disable: (reason?: string) => {
        clearP2PEnableTimer();
        applyP2PMode(false, reason);
      },
      scheduleEnable: scheduleEnableP2P,
    };
    const hlsConfig: Partial<HlsConfig> = {
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 30,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 10,
    };
    p2pHeartbeatTimer = window.setInterval(() => {
      updateP2PStats();
    }, 1_000);
    const attachHls = (nextHls: Hls) => {
      if (disposed) {
        nextHls.destroy();
        return;
      }

      hls = nextHls;
      hlsRef.current = nextHls;

      nextHls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
      nextHls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          nextHls.startLoad();
          startPlayback();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          nextHls.recoverMediaError();
          startPlayback();
          return;
        }
        setPlaybackStarting(false);
        setPageError(`hls-fatal:${String(data.type || "unknown")}`);
      });

      video.addEventListener("playing", onPlaying);
      video.addEventListener("waiting", onWaiting);
      video.addEventListener("loadeddata", onPlayable);
      video.addEventListener("canplay", onPlayable);

      nextHls.loadSource(src);
      nextHls.attachMedia(video);
    };

      void (async () => {
        try {
          const { default: P2pEngineHls } = await loadP2PEngineModule();
          if (disposed) return;

          const nextHls = new Hls(hlsConfig);
          const swarmCloudConfig: SwarmCloudP2PConfig = {
            live: true,
            trackerZone: SWARMCLOUD_TRACKER_ZONE,
            showSlogan: false,
            p2pEnabled: false,
            httpLoadTime: SWARMCLOUD_HTTP_LOAD_TIME_MS,
            token: SWARMCLOUD_TOKEN,
            channelId: `twofooty:${activeProvider}:m${matchId}`,
            swAutoRegister: true,
            swFile: SWARMCLOUD_SW_FILE,
            swScope: SWARMCLOUD_SW_SCOPE,
            sharePlaylist: true,
            hlsjsInstance: nextHls,
            getStats: (totalP2PDownloadedKB, totalP2PUploadedKB, totalHTTPDownloadedKB) => {
              p2pSnapshot.p2pDownloadedBytes = Math.max(0, Math.round(totalP2PDownloadedKB * 1024));
              p2pSnapshot.uploadedBytes = Math.max(0, Math.round(totalP2PUploadedKB * 1024));
              p2pSnapshot.httpDownloadedBytes = Math.max(0, Math.round(totalHTTPDownloadedKB * 1024));
            scheduleP2PStatsUpdate();
          },
            getPeersInfo: (peers) => {
              p2pSnapshot.peers = Array.isArray(peers) ? peers.length : 0;
              scheduleP2PStatsUpdate();
            },
          };

          try {
            await P2pEngineHls.tryRegisterServiceWorker(swarmCloudConfig);
          } catch (error) {
            console.warn("SwarmCloud service worker registration failed", error);
          }

          p2pEngine = new P2pEngineHls(swarmCloudConfig);
        p2pEngine.on("error", (error) => {
          p2pSnapshot.status = "P2P: engine error";
          scheduleP2PStatsUpdate();
          console.error("SwarmCloud P2P error", error);
        });
        p2pEngine.on("warning", (warning) => {
          p2pSnapshot.status = "P2P: warning";
          scheduleP2PStatsUpdate();
          console.warn("SwarmCloud P2P warning", warning);
        });
        applyP2PMode(false);
        updateP2PStats();
        attachHls(nextHls);
      } catch (error) {
        p2pEngine?.destroy();
        p2pEngine = null;
        if (disposed) return;
        setP2pStats({
          ...EMPTY_P2P_STATS,
          status: "P2P: فشل التهيئة",
        });
        console.error("P2P init failed", error);
        attachHls(new Hls(hlsConfig));
      }
    })();

    return () => {
      disposed = true;
      if (p2pFlushTimer !== null) {
        window.clearTimeout(p2pFlushTimer);
        p2pFlushTimer = null;
      }
      if (p2pHeartbeatTimer !== null) {
        window.clearInterval(p2pHeartbeatTimer);
        p2pHeartbeatTimer = null;
      }
      clearP2PEnableTimer();
      clearWaitingOverlayTimer();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("loadeddata", onPlayable);
      video.removeEventListener("canplay", onPlayable);
      p2pEngine?.destroy();
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      p2pControlRef.current = {
        enabled: false,
        enabledAt: 0,
        provider: null,
        streamUrl: "",
        disable: () => {},
        scheduleEnable: () => {},
      };
    };
  }, [activeProvider, clearWaitingOverlayTimer, matchId, playbackRequested, playerSessionNonce, streamUrl]);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="text-center">
          <div className="text-xl font-bold">جاري تحميل المباراة</div>
          <div className="text-sm text-slate-300 mt-2">يتم تجهيز المصادر المتاحة الآن.</div>
        </div>
      </main>
    );
  }

  if (!match) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="text-center max-w-xl">
          <div className="text-xl font-bold">تعذر فتح المباراة</div>
          <div className="text-sm text-slate-300 mt-2">{pageError || "لم يتم العثور على بيانات المباراة."}</div>
        </div>
      </main>
    );
  }

  const title = [match.home_team || "الفريق الأول", match.away_team || "الفريق الثاني"].join(" × ");
  const isBootstrapPending = (pendingBootstraps[activeProvider] || 0) > 0;
  const showPreparationProgress = !streamUrl && !!providerSourceUrl && (activePreparationActive || activeDisplayProgressPct > 0);
  const startupProgressPct = streamUrl && activeStatus?.state === "ready" ? 100 : activeDisplayProgressPct;
  const startupProgressLabel = streamUrl && activeStatus?.state === "ready" ? "تم تجهيز الرابط" : activePhaseLabel;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.28),_transparent_35%),linear-gradient(180deg,_#020617_0%,_#07111f_55%,_#020617_100%)] text-white">
      <section className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-4 flex justify-start">
          <a
            href="https://twofooty.com"
            className="inline-flex items-center rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
          >
            {"\u0627\u0644\u0631\u062c\u0648\u0639 \u0625\u0644\u0649 TwoFooty"}
          </a>
        </div>
        <div className="grid gap-6 lg:grid-cols-[1.6fr_0.8fr]">
          <div className="overflow-hidden rounded-3xl border border-white/10 bg-black/40 shadow-2xl shadow-black/40">
            <div className="relative aspect-video bg-black">
              <video
                ref={videoRef}
                className="h-full w-full"
                controls={false}
                playsInline
                preload="none"
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (!playbackRequested) {
                    requestPlaybackStart();
                    return;
                  }
                  if (video.paused) {
                    requestPlaybackStart();
                    return;
                  }
                  stopPlaybackSession();
                }}
              />

              {streamUrl && !playbackRequested ? (
                <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
                  <div className="text-3xl font-bold text-white">اضغط لبدء البث</div>
                  <button
                    type="button"
                    onClick={requestPlaybackStart}
                    className="rounded-2xl bg-teal-500 px-6 py-3 text-base font-bold text-slate-950 transition hover:bg-teal-400"
                  >
                    اضغط لبدء البث
                  </button>
                </div>
              ) : null}

              {!streamUrl ? (
                <div className="absolute inset-0 z-[55] flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
                  {showPreparationProgress ? (
                    <div className="w-full max-w-md">
                      <div className="flex items-center justify-between text-xs text-slate-300">
                        <span>{activePhaseLabel}</span>
                        <span>{activeDisplayProgressPct}%</span>
                      </div>
                      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/10">
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ${progressTone(activeStatus)}`}
                          style={{ width: `${activeDisplayProgressPct}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="text-2xl font-bold">{stateLabel(activeStatus)}</div>
                      <div className="text-sm text-slate-300">
                        {activeStatus?.reason || pageError || "waiting-for-playlist"}
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {playbackRequested && playbackStarting && (hasPlayedRef.current || !!streamUrl) ? (
                <div className="pointer-events-none absolute inset-0 z-[56] flex flex-col items-center justify-center gap-3 bg-black/35 px-6 text-center">
                  <div className="text-2xl font-bold text-white">
                    {hasPlayedRef.current ? "جاري استعادة البث" : "جاري بدء البث"}
                  </div>
                  <div className="text-sm text-slate-200">
                    {hasPlayedRef.current ? "قد يتأخر لثوانٍ بسيطة ثم يكمل." : "انتظر لحظة حتى يبدأ البث."}
                  </div>
                  {!hasPlayedRef.current ? (
                    <div className="w-full max-w-sm">
                      <div className="flex items-center justify-between text-xs text-slate-200">
                        <span>{startupProgressLabel}</span>
                        <span>{startupProgressPct}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/15">
                        <div
                          className="h-full rounded-full bg-emerald-400 transition-[width] duration-500"
                          style={{ width: `${startupProgressPct}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <VideoPlayerControls
                videoRef={videoRef}
                hls={hlsRef.current}
                title={title}
                isLive
                onPlayRequest={requestPlaybackStart}
                onPauseRequest={stopPlaybackSession}
              />
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <div className="flex items-center gap-3">
                {match.home_logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={match.home_logo} alt={match.home_team || "home"} className="h-14 w-14 rounded-full bg-white/90 object-contain p-1" />
                ) : (
                  <div className="h-14 w-14 rounded-full bg-white/10" />
                )}
                <div className="flex-1 text-center text-xl font-bold">{match.home_team || "الفريق الأول"}</div>
                {match.away_logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={match.away_logo} alt={match.away_team || "away"} className="h-14 w-14 rounded-full bg-white/90 object-contain p-1" />
                ) : (
                  <div className="h-14 w-14 rounded-full bg-white/10" />
                )}
              </div>
              <div className="mt-3 text-center text-lg font-semibold text-teal-200">{match.away_team || "الفريق الثاني"}</div>
              <div className="mt-4 text-sm text-slate-300">{formatKickoff(match.match_start)}</div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <div className="text-sm font-medium text-slate-300">المصادر</div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {PROVIDER_META.map((item) => {
                  const status = statusByProvider[item.provider];
                  const providerUnavailable = !providerHasMatchById[item.provider];
                  const isActive = activeProvider === item.provider;
                  return (
                    <button
                      key={item.provider}
                      type="button"
                      onClick={() => {
                        if (providerUnavailable) return;
                        if (item.provider !== selectedProvider) {
                          resetPlaybackState();
                        } else {
                          setPageError(null);
                        }
                        setSelectedProvider(item.provider);
                      }}
                      className={`rounded-2xl border px-4 py-3 text-right transition ${
                        providerUnavailable
                          ? "cursor-not-allowed border-rose-500/60 bg-rose-500/10 text-rose-100 opacity-80"
                          : isActive
                          ? "border-teal-400 bg-teal-500/15"
                          : "border-white/10 bg-slate-950/30 hover:bg-white/10"
                      }`}
                      disabled={providerUnavailable}
                    >
                      <div className="text-xs text-slate-400">مصدر {item.order}</div>
                      <div className="mt-1 font-semibold text-white">{status?.label || item.label}</div>
                      <div className={`mt-2 text-xs ${providerUnavailable ? "text-rose-200" : "text-slate-300"}`}>
                        {providerUnavailable ? "المصدر لا يعرض المباراة" : stateLabel(status)}
                      </div>
                      {status || providerUnavailable ? (
                        <div className="mt-3">
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span>
                              {providerUnavailable
                                ? "المصدر لا يعرض المباراة"
                                : status?.state === "warming"
                                  ? phaseLabel(status)
                                  : stateLabel(status)}
                            </span>
                            <span>
                              {providerUnavailable
                                ? "0%"
                                : `${status?.state === "ready" ? 100 : Math.round(displayProgressByProvider[item.provider] ?? progressPct(status))}%`}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/8">
                            <div
                              className={`h-full rounded-full transition-[width] duration-500 ${
                                providerUnavailable ? "bg-rose-500" : progressTone(status)
                              }`}
                              style={{
                                width: `${providerUnavailable ? 100 : status?.state === "ready" ? 100 : Math.round(displayProgressByProvider[item.provider] ?? progressPct(status))}%`,
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-slate-300">حالة البث</div>
                <div className={`rounded-full px-3 py-1 text-xs font-bold ${stateTone(activeStatus)}`}>{stateLabel(activeStatus)}</div>
              </div>
              <div className="mt-4 space-y-3 text-sm text-slate-200">
                <div>
                  <div className="flex items-center justify-between text-slate-400">
                    <span>نسبة التجهيز</span>
                    <span className="font-mono text-xs">{activeDisplayProgressPct}%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ${progressTone(activeStatus)}`}
                      style={{ width: `${activeDisplayProgressPct}%` }}
                    />
                  </div>
                  <div className="mt-2 text-xs text-slate-300">{activePhaseLabel}</div>
                </div>
                <div>
                  <div className="text-slate-400">المصدر المختار</div>
                  <div className="font-semibold">{activeStatus?.label || PROVIDER_META.find((item) => item.provider === activeProvider)?.label || activeProvider}</div>
                </div>
                <div>
                  <div className="text-slate-400">سبب الحالة</div>
                  <div className="break-all font-mono text-xs">{activeStatus?.reason || pageError || "n/a"}</div>
                </div>
                <div>
                  <div className="text-slate-400">رابط البث النهائي</div>
                  <div className="break-all font-mono text-xs text-teal-200">{streamUrl || "غير متاح بعد"}</div>
                </div>
                <div>
                  <div className="text-slate-400">المصدر الحالي</div>
                  <div className="break-all font-mono text-xs">{activeStatus?.currentSource || directSourceUrl || "غير متاح"}</div>
                </div>
              </div>
                <div>
                  <div className="text-slate-400">P2P</div>
                  <div className="break-all font-mono text-xs text-emerald-200">{p2pStatusLine}</div>
                </div>
              <div className="mt-5 flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setPageError(null);
                    void bootstrapProvider(activeProvider);
                  }}
                  className="rounded-2xl bg-teal-500 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isBootstrapPending}
                >
                  {isBootstrapPending ? "جاري التجهيز..." : "إعادة التجهيز"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPageError(null);
                    void loadMatch();
                    void refreshAllStatuses();
                  }}
                  className="rounded-2xl border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  تحديث الحالة
                </button>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
