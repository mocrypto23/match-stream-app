"use client";

import Hls from "hls.js";
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

const STATUS_POLL_MS = 4_000;
const ACTIVE_WARMING_POLL_MS = 1_250;
const AUTO_BOOTSTRAP_RETRY_MS = 12_000;
const ACTIVE_RECOVERY_RETRY_MS = 3_500;
const PLAYBACK_STALL_CHECK_MS = 2_000;
const SOFT_PLAYBACK_STALL_RECOVERY_MS = 2_500;
const HARD_PLAYBACK_STALL_RECOVERY_MS = 9_000;
const WAITING_OVERLAY_DELAY_MS = 3_500;
const PROVIDER_META: Array<{ provider: StreamProviderId; order: number; label: string }> = [
  { provider: "livekora", order: 1, label: "livekora vip" },
  { provider: "beinlive", order: 2, label: "bein-live" },
  { provider: "siiir", order: 3, label: "siiir.tv" },
];

function createPendingBootstrapMap(): PendingBootstrapMap {
  return { livekora: 0, beinlive: 0, siiir: 0 };
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const waitingOverlayTimerRef = useRef<number | null>(null);
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
    setRetainedPlaylistUrls({ livekora: "", beinlive: "", siiir: "" });
    setPendingBootstraps(createPendingBootstrapMap());
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
    return () => {
      clearWaitingOverlayTimer();
    };
  }, [clearWaitingOverlayTimer]);

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
        if (item.provider !== activeProvider && !playbackStarted) return false;
        const status = statusByProvider[item.provider];
        if (!String(status?.sourceUrl || "").trim()) return false;
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

      await Promise.all(
        providersToBootstrap.map(async (provider) => {
          if (cancelled) return;
          await bootstrapProvider(provider, { silent: true });
        })
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProvider, bootstrapProvider, match, pendingBootstraps, playbackStarted, statusByProvider]);

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

    clearWaitingOverlayTimer();
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (!video) return;

    video.pause();
    video.removeAttribute("src");
    video.load();

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

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
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

    if (!Hls.isSupported()) {
      setPlaybackStarting(false);
      setPageError("المتصفح لا يدعم HLS.");
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 30,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 10,
    });
    hlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        startPlayback();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
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

    hls.loadSource(src);
    hls.attachMedia(video);

    return () => {
      clearWaitingOverlayTimer();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("loadeddata", onPlayable);
      video.removeEventListener("canplay", onPlayable);
      hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [clearWaitingOverlayTimer, playbackRequested, playerSessionNonce, streamUrl]);

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
  const showPreparationProgress =
    !streamUrl &&
    !!providerSourceUrl &&
    (activeStatus?.state === "warming" || activeStatus?.reason === "not-bootstrapped" || activeStatus?.phase === "queued");

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
                        <span>{activeProgressPct}%</span>
                      </div>
                      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/10">
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ${progressTone(activeStatus)}`}
                          style={{ width: `${activeProgressPct}%` }}
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

              {playbackRequested && playbackStarting ? (
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
                        <span>تم تجهيز الرابط</span>
                        <span>100%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/15">
                        <div className="h-full w-full rounded-full bg-emerald-400" />
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
                            <span>{providerUnavailable ? "0%" : `${progressPct(status)}%`}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/8">
                            <div
                              className={`h-full rounded-full transition-[width] duration-500 ${
                                providerUnavailable ? "bg-rose-500" : progressTone(status)
                              }`}
                              style={{ width: `${providerUnavailable ? 100 : progressPct(status)}%` }}
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
                    <span className="font-mono text-xs">{activeProgressPct}%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ${progressTone(activeStatus)}`}
                      style={{ width: `${activeProgressPct}%` }}
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
