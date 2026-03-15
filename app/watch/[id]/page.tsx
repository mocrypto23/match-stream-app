"use client";

import Hls from "hls.js";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import VideoPlayerControls from "@/components/VideoPlayerControls";
import type { StreamProviderId, StreamSourceStatus } from "@/lib/stream-source-types";

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

const STATUS_POLL_MS = 4_000;
const AUTO_BOOTSTRAP_RETRY_MS = 12_000;
const PROVIDER_META: Array<{ provider: StreamProviderId; order: number; label: string }> = [
  { provider: "livekora", order: 1, label: "livekora vip" },
  { provider: "beinlive", order: 2, label: "bein-live" },
  { provider: "siiir", order: 3, label: "siiir.tv" },
];

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
  if (status.state === "warming") return "جاري تجهيز البث";
  return "البث غير جاهز";
}

function stateTone(status: StreamSourceStatus | null) {
  if (!status) return "bg-slate-700";
  if (status.state === "ready") return "bg-emerald-600";
  if (status.state === "warming") return "bg-amber-500";
  return "bg-rose-600";
}

function buildStatusMap(payload: MatchPayload | null): StatusMap {
  return {
    livekora: payload?.livekoraStatus || null,
    beinlive: payload?.beinliveStatus || null,
    siiir: payload?.siiirStatus || null,
  };
}

function pickInitialProvider(payload: MatchPayload | null) {
  const statuses = buildStatusMap(payload);
  const readyProvider = PROVIDER_META.find((item) => statuses[item.provider]?.state === "ready");
  if (readyProvider) return readyProvider.provider;
  const withSource = PROVIDER_META.find((item) => String(statuses[item.provider]?.sourceUrl || "").trim());
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
  const [bootstrapPendingProvider, setBootstrapPendingProvider] = useState<StreamProviderId | null>(null);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [playbackStarting, setPlaybackStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const waitingOverlayTimerRef = useRef<number | null>(null);
  const hasPlayedRef = useRef(false);
  const lastAutoBootstrapAtRef = useRef<Record<StreamProviderId, number>>({
    livekora: 0,
    beinlive: 0,
    siiir: 0,
  });

  const sources = useMemo(
    () =>
      PROVIDER_META.map((item) => statusByProvider[item.provider]).filter(Boolean).sort((left, right) => {
        return Number(left?.order || 0) - Number(right?.order || 0);
      }) as StreamSourceStatus[],
    [statusByProvider]
  );

  const activeStatus = useMemo(() => {
    return sources.find((item) => item.provider === selectedProvider) || sources[0] || null;
  }, [selectedProvider, sources]);

  const activeProvider = activeStatus?.provider || selectedProvider;

  const streamUrl = useMemo(() => {
    const direct = String(activeStatus?.playlistUrl || "").trim();
    if (direct) return direct;
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
  }, [activeProvider, activeStatus?.playlistUrl, match?.beinlivePlaylistUrl, match?.livekoraPlaylistUrl, match?.siiirPlaylistUrl]);

  const directSourceUrl = useMemo(() => {
    if (activeProvider === "livekora") return String(match?.stream_url_4 || "").trim() || null;
    if (activeProvider === "beinlive") return String(match?.stream_url || "").trim() || null;
    return String(match?.stream_url_2 || "").trim() || null;
  }, [activeProvider, match?.stream_url, match?.stream_url_2, match?.stream_url_4]);

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
      setBootstrapPendingProvider(provider);
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
        setBootstrapPendingProvider((current) => (current === provider ? null : current));
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

  useEffect(() => {
    void loadMatch();
  }, [loadMatch]);

  useEffect(() => {
    setPlaybackRequested(false);
    setPlaybackStarting(false);
    clearWaitingOverlayTimer();
    hasPlayedRef.current = false;
    setStatusByProvider({ livekora: null, beinlive: null, siiir: null });
    setSelectedProvider("livekora");
  }, [clearWaitingOverlayTimer, matchId]);

  useEffect(() => {
    return () => {
      clearWaitingOverlayTimer();
    };
  }, [clearWaitingOverlayTimer]);

  useEffect(() => {
    if (!match) return;
    if (!String(activeStatus?.sourceUrl || "").trim()) return;
    void bootstrapProvider(activeProvider, { silent: true });
  }, [activeProvider, activeStatus?.sourceUrl, bootstrapProvider, match]);

  useEffect(() => {
    if (!match) return;
    if (!String(activeStatus?.sourceUrl || "").trim()) return;
    if (activeStatus?.reason !== "not-bootstrapped") return;
    if (bootstrapPendingProvider === activeProvider) return;

    const now = Date.now();
    const lastAttemptAt = lastAutoBootstrapAtRef.current[activeProvider] || 0;
    if (now - lastAttemptAt < AUTO_BOOTSTRAP_RETRY_MS) return;

    lastAutoBootstrapAtRef.current[activeProvider] = now;
    void bootstrapProvider(activeProvider, { silent: true });
  }, [
    activeProvider,
    activeStatus?.reason,
    activeStatus?.sourceUrl,
    bootstrapPendingProvider,
    bootstrapProvider,
    match,
  ]);

  useEffect(() => {
    if (!matchId || Number.isNaN(matchId)) return;
    const id = window.setInterval(() => {
      void refreshAllStatuses();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [matchId, refreshAllStatuses]);

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
      setPlaybackStarting(false);
      setPageError(null);
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
      }, 1200);
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("playing", onPlaying);
      video.addEventListener("waiting", onWaiting);
      startPlayback();
      return () => {
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("waiting", onWaiting);
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

    hls.loadSource(src);
    hls.attachMedia(video);

    return () => {
      clearWaitingOverlayTimer();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [clearWaitingOverlayTimer, playbackRequested, streamUrl]);

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
  const isBootstrapPending = bootstrapPendingProvider === activeProvider;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.28),_transparent_35%),linear-gradient(180deg,_#020617_0%,_#07111f_55%,_#020617_100%)] text-white">
      <section className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
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
                    void video.play().catch(() => {});
                    return;
                  }
                  video.pause();
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
                  <div className="text-2xl font-bold">{stateLabel(activeStatus)}</div>
                  <div className="text-sm text-slate-300">
                    {activeStatus?.reason || pageError || "waiting-for-playlist"}
                  </div>
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
                </div>
              ) : null}

              <VideoPlayerControls videoRef={videoRef} hls={hlsRef.current} title={title} isLive />
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
                  const isActive = activeProvider === item.provider;
                  return (
                    <button
                      key={item.provider}
                      type="button"
                      onClick={() => {
                        setPageError(null);
                        setSelectedProvider(item.provider);
                      }}
                      className={`rounded-2xl border px-4 py-3 text-right transition ${
                        isActive
                          ? "border-teal-400 bg-teal-500/15"
                          : "border-white/10 bg-slate-950/30 hover:bg-white/10"
                      }`}
                    >
                      <div className="text-xs text-slate-400">مصدر {item.order}</div>
                      <div className="mt-1 font-semibold text-white">{status?.label || item.label}</div>
                      <div className="mt-2 text-xs text-slate-300">{stateLabel(status)}</div>
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
