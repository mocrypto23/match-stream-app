"use client";

import Hls from "hls.js";
import VideoPlayerControls from "@/components/VideoPlayerControls";
import type { LivekoraStatus } from "@/lib/livekora-types";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MatchPayload = {
  id: number;
  home_team?: string | null;
  away_team?: string | null;
  home_logo?: string | null;
  away_logo?: string | null;
  match_start?: string | null;
  match_day?: string | null;
  status_key?: string | null;
  stream_url_4?: string | null;
  livekoraStatus?: LivekoraStatus | null;
  livekoraPlaylistUrl?: string | null;
};

const STATUS_POLL_MS = 4_000;

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

function stateLabel(status: LivekoraStatus | null) {
  if (!status) return "جاري التحميل";
  if (status.state === "ready") return "البث جاهز";
  if (status.state === "warming") return "جاري تجهيز البث";
  return "البث غير جاهز";
}

function stateTone(status: LivekoraStatus | null) {
  if (!status) return "bg-slate-700";
  if (status.state === "ready") return "bg-emerald-600";
  if (status.state === "warming") return "bg-amber-500";
  return "bg-rose-600";
}

export default function WatchPage() {
  const params = useParams<{ id?: string }>();
  const matchId = Number.parseInt(String(params?.id || "").trim(), 10);
  const [match, setMatch] = useState<MatchPayload | null>(null);
  const [status, setStatus] = useState<LivekoraStatus | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const streamUrl = useMemo(() => {
    const direct = String(status?.playlistUrl || "").trim();
    if (direct) return direct;
    const fallback = String(match?.livekoraPlaylistUrl || "").trim();
    return fallback || null;
  }, [match?.livekoraPlaylistUrl, status?.playlistUrl]);

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
      setStatus(payload.livekoraStatus || null);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "تعذر تحميل المباراة.");
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  const refreshStatus = useCallback(async () => {
    if (!Number.isFinite(matchId) || matchId <= 0) return;
    try {
      const response = await fetch(`/api/livekora/status?matchId=${encodeURIComponent(String(matchId))}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as { livekoraStatus?: LivekoraStatus | null } | null;
      if (response.ok && payload?.livekoraStatus) {
        setStatus(payload.livekoraStatus);
      }
    } catch {}
  }, [matchId]);

  const bootstrap = useCallback(async () => {
    if (!Number.isFinite(matchId) || matchId <= 0) return;
    setBootstrapPending(true);
    try {
      const response = await fetch("/api/livekora/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ matchId }),
      });
      const payload = (await response.json().catch(() => null)) as { livekoraStatus?: LivekoraStatus | null; reason?: string } | null;
      if (payload?.livekoraStatus) {
        setStatus(payload.livekoraStatus);
      }
      if (!response.ok && payload?.reason) {
        setPageError(payload.reason);
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "bootstrap-failed");
    } finally {
      setBootstrapPending(false);
    }
  }, [matchId]);

  useEffect(() => {
    void loadMatch();
  }, [loadMatch]);

  useEffect(() => {
    if (!match) return;
    if (!String(match.stream_url_4 || "").trim()) return;
    void bootstrap();
  }, [bootstrap, match]);

  useEffect(() => {
    if (!matchId || Number.isNaN(matchId)) return;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [matchId, refreshStatus]);

  useEffect(() => {
    const video = videoRef.current;
    const src = String(streamUrl || "").trim();

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (!video) return;

    video.removeAttribute("src");
    video.load();
    if (!src) return;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      void video.play().catch(() => {});
      return;
    }

    if (!Hls.isSupported()) {
      setPageError("المتصفح لا يدعم HLS.");
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
    });
    hlsRef.current = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        setPageError(`hls-fatal:${String(data.type || "unknown")}`);
      }
    });

    return () => {
      hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [streamUrl]);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="text-center">
          <div className="text-xl font-bold">جاري تحميل المباراة</div>
          <div className="text-sm text-slate-300 mt-2">يتم تجهيز مسار livekora الآن.</div>
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
                autoPlay
                muted
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (video.paused) {
                    void video.play().catch(() => {});
                    return;
                  }
                  video.pause();
                }}
              />
              {!streamUrl ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
                  <div className="text-2xl font-bold">{stateLabel(status)}</div>
                  <div className="text-sm text-slate-300">{status?.reason || pageError || "waiting-for-playlist"}</div>
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
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-slate-300">حالة البث</div>
                <div className={`rounded-full px-3 py-1 text-xs font-bold ${stateTone(status)}`}>{stateLabel(status)}</div>
              </div>
              <div className="mt-4 space-y-3 text-sm text-slate-200">
                <div>
                  <div className="text-slate-400">المزود</div>
                  <div className="font-semibold">livekora</div>
                </div>
                <div>
                  <div className="text-slate-400">سبب الحالة</div>
                  <div className="break-all font-mono text-xs">{status?.reason || pageError || "n/a"}</div>
                </div>
                <div>
                  <div className="text-slate-400">رابط البث النهائي</div>
                  <div className="break-all font-mono text-xs text-teal-200">{streamUrl || "غير متاح بعد"}</div>
                </div>
                <div>
                  <div className="text-slate-400">المصدر الحالي</div>
                  <div className="break-all font-mono text-xs">{status?.currentSource || match.stream_url_4 || "غير متاح"}</div>
                </div>
              </div>
              <div className="mt-5 flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setPageError(null);
                    void bootstrap();
                  }}
                  className="rounded-2xl bg-teal-500 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={bootstrapPending}
                >
                  {bootstrapPending ? "جاري التجهيز..." : "إعادة التجهيز"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPageError(null);
                    void loadMatch();
                    void refreshStatus();
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
