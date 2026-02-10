"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

type MatchRow = {
  id: number;
  home_team?: string | null;
  away_team?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
  stream_url_5?: string | null;
  stream_url_6?: string | null;
  stream_url_7?: string | null;
  match_start?: string | null;
  status_key?: string | null;
};

function isValidHttpUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatStartTimeAr(iso?: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

const SAFE_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock";
const USE_SERVER2_SANDBOX = true;
const SERVER2_SANDBOX = SAFE_IFRAME_SANDBOX;
const USE_SERVER3_SANDBOX = true;
const SERVER3_SANDBOX = SAFE_IFRAME_SANDBOX;
const USE_EMBED_PROXY = true;
const EMBED_PROXY_SANDBOX: string | undefined = undefined;
const PREMATCH_OPEN_WINDOW_MINUTES = 15;

function toEmbedProxyUrl(rawUrl?: string | null, opts?: { ref?: string; stable?: boolean }) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  const appendMissingProxyParams = (query: URLSearchParams) => {
    if (opts?.ref && isValidHttpUrl(opts.ref) && !query.get("ref")) {
      query.set("ref", opts.ref);
    }
    if (opts?.stable && query.get("stable") !== "1") {
      query.set("stable", "1");
    }
    return `/api/embed-proxy?${query.toString()}`;
  };

  if (value.startsWith("/api/embed-proxy?")) {
    const query = new URLSearchParams(value.slice("/api/embed-proxy?".length));
    return appendMissingProxyParams(query);
  }

  if (!isValidHttpUrl(value)) return "";
  try {
    const u = new URL(value);
    if (u.pathname === "/api/embed-proxy") {
      return appendMissingProxyParams(new URLSearchParams(u.search));
    }
  } catch {}

  const query = new URLSearchParams();
  query.set("url", value);
  query.set("depth", "0");
  if (opts?.ref && isValidHttpUrl(opts.ref)) query.set("ref", opts.ref);
  if (opts?.stable) query.set("stable", "1");
  return appendMissingProxyParams(query);
}

function normalizeServer3AlbaplayerUrl(rawUrl?: string | null) {
  const value = String(rawUrl || "").trim();
  if (!value || !isValidHttpUrl(value)) return value;
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isAlbaplayer = path.includes("/albaplayer/") || path.includes("/alba.php");
    const isLivehdChain = host.includes("alkoora.live") || host.includes("livehd77.pro");
    if (!isLivehdChain || !isAlbaplayer) return value;
    // Always start Server 3 on channel 1 as requested.
    u.searchParams.set("serv", "1");
    return u.toString();
  } catch {
    return value;
  }
}

function shouldUseStableModeForServer(serverNumber: number, rawUrl?: string | null) {
  const value = String(rawUrl || "").trim();
  if (!value || !isValidHttpUrl(value)) return false;

  // Keep "stable" mode mainly for server-3 style alba players.
  if (serverNumber === 3) return true;

  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return host.includes("alkoora.live") || host.includes("livehd77.pro");
  } catch {
    return false;
  }
}

export default function WatchPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawId = useMemo(() => {
    const v = (params as any)?.id;
    return Array.isArray(v) ? v[0] : v;
  }, [params]);

  const idNum = useMemo(() => {
    const s = String(rawId ?? "").trim();
    if (!s) return null;
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [rawId]);

  const [match, setMatch] = useState<MatchRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<number>(1);
  const [diagLogs, setDiagLogs] = useState<string[]>([]);
  const [diagLoadMs, setDiagLoadMs] = useState<number | null>(null);
  const [diagStartAt, setDiagStartAt] = useState<number | null>(null);

  const diagEnabled = searchParams.get("diag") === "1";

  const pushDiag = (line: string) => {
    setDiagLogs((prev) => [line, ...prev].slice(0, 120));
  };

  useEffect(() => {
    let cancelled = false;

    const fetchMatch = async () => {
      setLoading(true);
      setErrMsg(null);
      setMatch(null);

      if (idNum === null) {
        setLoading(false);
        setErrMsg("رقم المباراة غير صالح في الرابط.");
        return;
      }

      try {
        const res = await fetch(`/api/match/${encodeURIComponent(String(idNum))}`);

        const json = await res.json().catch(() => null);

        if (cancelled) return;

        if (!res.ok) {
          setErrMsg(json?.error || `فشل تحميل المباراة (${res.status})`);
          setLoading(false);
          return;
        }

        setMatch(json as MatchRow);
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setErrMsg(e?.message || "Network error");
        setLoading(false);
      }
    };

    fetchMatch();

    return () => {
      cancelled = true;
    };
  }, [idNum]);

  const servers = useMemo(() => {
    return [
      { n: 1, url: match?.stream_url ?? null },
      { n: 2, url: match?.stream_url_2 ?? null },
      { n: 3, url: match?.stream_url_3 ?? null },
      // Requested ordering: keep best source (old server 5) as displayed server 4.
      { n: 4, url: match?.stream_url_5 ?? match?.stream_url_4 ?? null },
      { n: 5, url: match?.stream_url_6 ?? null },
      { n: 6, url: match?.stream_url_7 ?? null },
    ]
      .filter((x) => x.url && isValidHttpUrl(x.url))
      .map((x) => ({ n: x.n, url: x.url as string }));
  }, [match]);

  useEffect(() => {
    const exists = servers.some((x) => x.n === selectedServer);
    if (!exists && servers.length) setSelectedServer(servers[0].n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.length, servers.map((s) => s.n).join(","), selectedServer]);
  const home = match?.home_team ?? "الفريق الأول";
  const away = match?.away_team ?? "الفريق الثاني";

  const selectedUrl = servers.find((x) => x.n === selectedServer)?.url ?? "";

  const normalizedSelectedUrl = selectedServer === 3 ? normalizeServer3AlbaplayerUrl(selectedUrl) : selectedUrl;
  const shouldUseEmbedProxy = USE_EMBED_PROXY;
  const useStableMode = shouldUseStableModeForServer(selectedServer, normalizedSelectedUrl);
  const iframeSrc = shouldUseEmbedProxy
    ? toEmbedProxyUrl(normalizedSelectedUrl, { ref: normalizedSelectedUrl, stable: useStableMode })
    : normalizedSelectedUrl;
  const canEmbed = iframeSrc.length > 0;

  useEffect(() => {
    if (!diagEnabled || !iframeSrc) return;
    setDiagStartAt(Date.now());
    setDiagLoadMs(null);
  }, [diagEnabled, iframeSrc, selectedServer]);

  useEffect(() => {
    if (!diagEnabled) return;
    const onMessage = (ev: MessageEvent) => {
      const payload = ev.data as any;
      if (!payload || payload.type !== "__embed_proxy_diag") return;
      const ts = new Date(Number(payload.ts) || Date.now()).toLocaleTimeString("en-GB");
      let dataPart = "";
      try {
        dataPart = payload.data ? " " + JSON.stringify(payload.data) : "";
      } catch {}
      pushDiag(`[${ts}] ${String(payload.event || "event")}${dataPart}`);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [diagEnabled]);

  const onIframeLoad = () => {
    if (!diagEnabled) return;
    const now = Date.now();
    const ms = diagStartAt ? now - diagStartAt : null;
    if (ms !== null) setDiagLoadMs(ms);
    const ts = new Date(now).toLocaleTimeString("en-GB");
    pushDiag(`[${ts}] iframe_loaded server=${selectedServer}${ms !== null ? ` in ${ms}ms` : ""}`);
  };

  const onIframeError = () => {
    if (!diagEnabled) return;
    const ts = new Date().toLocaleTimeString("en-GB");
    pushDiag(`[${ts}] iframe_error server=${selectedServer}`);
  };

  const status = (match?.status_key ?? "").toLowerCase();
  const nowMs = Date.now();
  const startMs = match?.match_start ? new Date(match.match_start).getTime() : null;
  const startValid = startMs !== null && Number.isFinite(startMs);
  const prematchWindowMs = PREMATCH_OPEN_WINDOW_MINUTES * 60 * 1000;

  const hasStartedByTime = startValid ? nowMs >= (startMs as number) - prematchWindowMs : false;
  const hasStartedByStatus = status === "live" || status === "finished";
  const isUpcomingByStatus = status === "upcoming";

  const shouldBlockStream = !hasStartedByStatus && (startValid ? !hasStartedByTime : isUpcomingByStatus);

  const prettyStart = formatStartTimeAr(match?.match_start);
  const isServer2 = selectedServer === 2;
  const isServer3 = selectedServer === 3;


  if (loading) {
    return <div className="text-white text-center mt-20">جاري تحميل البث...</div>;
  }

  if (errMsg) {
    return (
      <div className="min-h-screen bg-black text-white p-4">
        <div className="max-w-3xl mx-auto mt-10">
          <div className="mb-4 flex flex-wrap items-center gap-3">
          <button onClick={() => router.replace("/")} className="text-gray-400 hover:text-white">
            Back Home
          </button>
          <Link href="/test" className="text-blue-400 hover:text-blue-300 font-bold text-sm">
            Test
          </Link>
        </div>

          <div className="bg-[#161616] p-6 rounded-2xl border border-gray-800">
            <div className="font-bold mb-2">تعذر فتح صفحة المشاهدة</div>
            <div className="text-gray-300 break-words">{errMsg}</div>
            <div className="text-gray-500 mt-3 text-sm">
              لو بتستخدم API routes: اتأكد إن `_supabase.ts` بيقرأ Service Role Key على السيرفر فقط.
            </div>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-5xl mx-auto">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button onClick={() => router.replace("/")} className="text-gray-400 hover:text-white">
            Back Home
          </button>
          <Link href="/test" className="text-blue-400 hover:text-blue-300 font-bold text-sm">
            Test
          </Link>
          <Link
            href={diagEnabled ? `/watch/${idNum ?? rawId}` : `/watch/${idNum ?? rawId}?diag=1`}
            className="text-amber-400 hover:text-amber-300 font-bold text-sm"
          >
            {diagEnabled ? "Diag Off" : "Diag On"}
          </Link>
        </div>

        <div className="mb-4 rounded-2xl border border-gray-800 bg-gradient-to-r from-[#1b1b1b] via-[#111111] to-[#1b1b1b] p-5 shadow-2xl">
          <div className="flex flex-col gap-2 items-center text-center">
            <div className="text-2xl sm:text-3xl font-black tracking-wide">مفيش إعلانات</div>
            <div className="text-2xl sm:text-3xl font-black tracking-wide">دبل كليك على الفيديو وحيكبر بسهولة</div>
          </div>
        </div>

        {servers.length > 1 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {servers.map((s) => (
              <button
                key={s.n}
                onClick={() => setSelectedServer(s.n)}
                className={[
                  "px-4 py-2 rounded-full font-black text-sm border transition-all",
                  selectedServer === s.n
                    ? "bg-blue-600/20 text-blue-400 border-blue-600/40"
                    : "bg-[#121212] text-gray-300 border-gray-800 hover:border-blue-600/40",
                ].join(" ")}
              >
                سيرفر {s.n}
              </button>
            ))}
          </div>
        ) : null}

        <div className="bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-gray-800">
          {shouldBlockStream ? (
            <div className="flex flex-col gap-2 items-center justify-center h-[55vh] min-h-[320px] text-gray-400 p-6 text-center">
              <div className="text-white font-bold text-xl">لم يبدأ البث بعد</div>
              {prettyStart ? (
                <div className="text-sm text-gray-400">
                  موعد المباراة: <span className="text-gray-200">{prettyStart}</span>
                </div>
              ) : (
                <div className="text-sm text-gray-500">سيتم تفعيل البث عند بدء المباراة.</div>
              )}
            </div>
          ) : canEmbed ? (
            isServer2 ? (
              <div className="relative">
                <iframe
                  key={`${selectedServer}-${iframeSrc}`}
                  src={iframeSrc}
                  className="w-full block"
                  style={{ height: 620 }}
                  frameBorder={0}
                  allowFullScreen
                  allow="autoplay; fullscreen"
                  sandbox={
                    shouldUseEmbedProxy
                      ? EMBED_PROXY_SANDBOX
                      : USE_SERVER2_SANDBOX
                      ? SERVER2_SANDBOX
                      : undefined
                  }
                  onLoad={onIframeLoad}
                  onError={onIframeError}
                  title={`Live Stream Server ${selectedServer}`}
                />
              </div>
            ) : isServer3 ? (
              <div className="h-[70vh] min-h-[430px] max-h-[820px]">
                <div className="w-[97.6%] h-full mx-auto">
                  <iframe
                    key={`${selectedServer}-${iframeSrc}`}
                    src={iframeSrc}
                    className="w-full h-full"
                    allowFullScreen
                    scrolling="no"
                    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                    sandbox={
                      shouldUseEmbedProxy
                        ? EMBED_PROXY_SANDBOX
                        : USE_SERVER3_SANDBOX
                        ? SERVER3_SANDBOX
                        : undefined
                    }
                    onLoad={onIframeLoad}
                    onError={onIframeError}
                    title={`Live Stream Server ${selectedServer}`}
                  />
                </div>
              </div>
            ) : (
              <div className="h-[70vh] min-h-[430px] max-h-[820px]">
                <iframe
                  key={`${selectedServer}-${iframeSrc}`}
                  src={iframeSrc}
                  className="w-full h-full"
                  allowFullScreen
                  scrolling="no"
                  allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                  sandbox={shouldUseEmbedProxy ? EMBED_PROXY_SANDBOX : SAFE_IFRAME_SANDBOX}
                  onLoad={onIframeLoad}
                  onError={onIframeError}
                  title={`Live Stream Server ${selectedServer}`}
                />
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2 items-center justify-center h-[55vh] min-h-[320px] text-gray-400 p-6 text-center">
              <div className="text-gray-300 font-semibold">رابط البث غير متوفر أو غير صالح للعرض داخل iframe</div>

              {normalizedSelectedUrl ? (
                <div className="text-xs text-gray-500 break-words">
                  الحالي: <span className="text-gray-400">{normalizedSelectedUrl}</span>
                </div>
              ) : null}

              {normalizedSelectedUrl ? (
                <a
                  href={normalizedSelectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 text-sm font-bold text-blue-400 hover:text-blue-300"
                >
                  فتح الرابط في صفحة جديدة
                </a>
              ) : null}
            </div>
          )}
        </div>

        {diagEnabled ? (
          <div className="mt-3 rounded-xl border border-amber-700/40 bg-[#16130a] p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-xs text-amber-300">
                Diag Mode: server={selectedServer} {diagLoadMs !== null ? `load=${diagLoadMs}ms` : ""}
              </div>
              <button
                onClick={() => setDiagLogs([])}
                className="text-[11px] px-2 py-1 rounded border border-amber-700/40 text-amber-300"
              >
                Clear
              </button>
            </div>
            <div className="max-h-48 overflow-auto text-[11px] text-amber-100/90 whitespace-pre-wrap leading-5">
              {diagLogs.length ? diagLogs.join("\n") : "No diag events yet."}
            </div>
          </div>
        ) : null}

        <div className="mt-6 bg-[#161616] p-6 rounded-2xl border border-gray-800 flex justify-between items-center">
          <div className="text-center flex-1 font-bold text-xl">{home}</div>
          <div className="text-red-500 font-black px-4">VS</div>
          <div className="text-center flex-1 font-bold text-xl">{away}</div>
        </div>
      </div>
    </div>
  );
}

