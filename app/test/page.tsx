"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";

const DEFAULT_IFRAME_URL = "https://p.pyxq.online/albaplayer/bein2/";
const DEFAULT_HLS_URL = "https://cdn33.4job.online/live/bein2/chunks.m3u8?nimblesessionid=322784";
const DEFAULT_HLS_REF = "https://p.pyxq.online/bein2/";

type IframeMode = "direct" | "proxy" | "proxy_stable";
type HlsMode = "direct" | "proxy";

type TestPreset = {
  id: string;
  label: string;
  url: string;
  ref?: string;
  notes?: string;
};

const PRESETS: TestPreset[] = [
  {
    id: "baseline-iframe",
    label: "Baseline Albaplayer Iframe",
    url: "https://p.pyxq.online/albaplayer/bein2/",
    notes: "Known-good iframe source from your tests.",
  },
  {
    id: "server-1-m3u8",
    label: "Server 1 m3u8 (yallaliveshoot)",
    url: "https://cdzgq.yallaliveshoot.info/hls/ch3/live/index.m3u8",
    ref: "https://www.yallaliveshoot.info/",
    notes: "HLS playlist. Test direct and via proxy.",
  },
  {
    id: "server-2-token",
    label: "Server 2 token URL (yallashot)",
    url: "https://jqyjghfms1mu8zc.yallashot.us/kooora/6f86bdcsdqdsdf4ss333_sd?ts=1770754573&nonce=eFuD163x&token=2065413922&sid=93a96b11911041d276df396855cc3196",
    notes: "Tokenized endpoint. Can expire quickly.",
  },
  {
    id: "server-3-ts",
    label: "Server 3 TS segment",
    url: "https://ff2srpr7.04334746.net:8443/hls/9cznqhfs9-77056200.ts",
    notes: "Single TS file, not a full playlist.",
  },
  {
    id: "server-5-m3u8",
    label: "Server 5 m3u8 sample",
    url: "https://cdn5.4job.online/live/x3/chunks.m3u8?nimblesessionid=2892675",
    ref: "https://p.pyxq.online/albaplayer/bein3/",
    notes: "Extracted from your current best stream path.",
  },
];

function isValidHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function toEmbedProxyUrl(rawUrl: string, opts?: { ref?: string; stable?: boolean }) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  if (value.startsWith("/api/embed-proxy?")) return value;

  if (!isValidHttpUrl(value)) return "";
  try {
    const u = new URL(value);
    if (u.pathname === "/api/embed-proxy") {
      return `${u.pathname}${u.search}`;
    }
  } catch {}

  const params = new URLSearchParams();
  params.set("url", value);
  params.set("depth", "0");
  if (opts?.ref && isValidHttpUrl(opts.ref)) params.set("ref", opts.ref);
  if (opts?.stable) params.set("stable", "1");
  return `/api/embed-proxy?${params.toString()}`;
}

function toPyxqAlbaplayerUrl(rawUrl: string) {
  const value = String(rawUrl || "").trim();
  if (!isValidHttpUrl(value)) return value;

  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    const isPyxq = host === "p.pyxq.online" || host.endsWith(".pyxq.online");
    if (!isPyxq) return value;

    const path = u.pathname.toLowerCase();
    if (path.includes("/albaplayer/") || path.includes("/alba.php")) return value;

    const slug = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!slug) return value;
    return `${u.protocol}//${u.host}/albaplayer/${slug}/`;
  } catch {
    return value;
  }
}

export default function TestPage() {
  const [iframeUrl, setIframeUrl] = useState(DEFAULT_IFRAME_URL);
  const [iframeMode, setIframeMode] = useState<IframeMode>("proxy");

  const [hlsUrl, setHlsUrl] = useState(DEFAULT_HLS_URL);
  const [hlsRef, setHlsRef] = useState(DEFAULT_HLS_REF);
  const [hlsMode, setHlsMode] = useState<HlsMode>("proxy");
  const [hlsLogs, setHlsLogs] = useState<string[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const resolvedIframeUrl = useMemo(() => {
    const value = String(iframeUrl || "").trim();
    if (!value || !isValidHttpUrl(value)) return "";

    if (iframeMode === "direct") return value;
    if (iframeMode === "proxy_stable") return toEmbedProxyUrl(value, { stable: true });
    return toEmbedProxyUrl(value);
  }, [iframeMode, iframeUrl]);

  const resolvedHlsUrl = useMemo(() => {
    const value = String(hlsUrl || "").trim();
    if (!value || !isValidHttpUrl(value)) return "";
    if (hlsMode === "direct") return value;
    return toEmbedProxyUrl(value, { ref: hlsRef });
  }, [hlsMode, hlsRef, hlsUrl]);

  const applyPresetToIframe = (preset: TestPreset, mode: IframeMode = "proxy") => {
    setIframeUrl(preset.url);
    setIframeMode(mode);
  };

  const applyPresetToHls = (preset: TestPreset, mode: HlsMode = "proxy") => {
    setHlsUrl(preset.url);
    setHlsMode(mode);
    if (preset.ref) setHlsRef(preset.ref);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const pushLog = (message: string) => {
      setHlsLogs((prev) => {
        const ts = new Date().toLocaleTimeString("en-GB");
        return [`${ts} - ${message}`, ...prev].slice(0, 24);
      });
    };

    setHlsLogs([]);

    let hls: Hls | null = null;
    video.pause();
    video.removeAttribute("src");
    video.load();

    if (!resolvedHlsUrl) {
      pushLog("No HLS URL");
      return;
    }

    pushLog(`Source => ${resolvedHlsUrl}`);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = resolvedHlsUrl;
      video.load();
      pushLog("Native HLS path enabled");
      return;
    }

    if (!Hls.isSupported()) {
      pushLog("Hls.js is not supported on this browser");
      return;
    }

    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
    });

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      pushLog("Media attached");
      hls?.loadSource(resolvedHlsUrl);
    });

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      pushLog(`Manifest parsed, levels=${data.levels.length}`);
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      pushLog(`ERROR type=${data.type} details=${data.details} fatal=${String(data.fatal)}`);
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls?.startLoad();
        pushLog("Network recovery => startLoad()");
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls?.recoverMediaError();
        pushLog("Media recovery => recoverMediaError()");
      } else {
        hls?.destroy();
        pushLog("Fatal unrecoverable error => destroy()");
      }
    });

    hls.attachMedia(video);

    return () => {
      hls?.destroy();
    };
  }, [resolvedHlsUrl]);

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-6xl mx-auto">
        <div className="mb-4 flex flex-wrap gap-2">
          <Link href="/" className="px-4 py-2 rounded-full border border-gray-700 text-gray-200 hover:bg-gray-800">
            Back Home
          </Link>
          <Link
            href="/watch/1"
            className="px-4 py-2 rounded-full border border-gray-700 text-gray-200 hover:bg-gray-800"
          >
            Watch Example
          </Link>
        </div>

        <h1 className="text-2xl font-black mb-3">Stream Test Lab</h1>
        <p className="text-sm text-gray-400 mb-6">
          Proxy can suppress most overlays/popups, but ads baked into the actual video stream cannot be removed 100%.
        </p>

        <section className="mb-8 rounded-2xl border border-gray-800 bg-[#111] p-4">
          <h2 className="text-lg font-bold mb-3">Preset Links (Your Latest Findings)</h2>
          <div className="grid gap-3">
            {PRESETS.map((preset) => (
              <div key={preset.id} className="rounded-xl border border-gray-800 bg-black/50 p-3">
                <div className="font-semibold mb-1">{preset.label}</div>
                <div className="text-xs text-gray-400 break-all">{preset.url}</div>
                {preset.ref ? <div className="text-xs text-gray-500 break-all mt-1">ref: {preset.ref}</div> : null}
                {preset.notes ? <div className="text-xs text-gray-500 mt-2">{preset.notes}</div> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => applyPresetToIframe(preset, "proxy")}
                    className="px-3 py-1 rounded-lg border border-gray-700 text-xs"
                  >
                    Iframe via proxy
                  </button>
                  <button
                    onClick={() => applyPresetToIframe(preset, "direct")}
                    className="px-3 py-1 rounded-lg border border-gray-700 text-xs"
                  >
                    Iframe direct
                  </button>
                  <button
                    onClick={() => applyPresetToHls(preset, "proxy")}
                    className="px-3 py-1 rounded-lg border border-gray-700 text-xs"
                  >
                    HLS via proxy
                  </button>
                  <button
                    onClick={() => applyPresetToHls(preset, "direct")}
                    className="px-3 py-1 rounded-lg border border-gray-700 text-xs"
                  >
                    HLS direct
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-8 rounded-2xl border border-gray-800 bg-[#111] p-4">
          <h2 className="text-lg font-bold mb-3">Iframe Test</h2>

          <div className="grid gap-3">
            <input
              value={iframeUrl}
              onChange={(e) => setIframeUrl(e.target.value)}
              className="w-full rounded-lg bg-black border border-gray-700 p-2 text-sm"
              placeholder="Iframe URL"
            />

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setIframeUrl(DEFAULT_IFRAME_URL)}
                className="px-3 py-1 rounded-lg border border-gray-700 text-sm"
              >
                Reset default
              </button>
              <button
                onClick={() => setIframeUrl(toPyxqAlbaplayerUrl(iframeUrl))}
                className="px-3 py-1 rounded-lg border border-gray-700 text-sm"
              >
                Convert to albaplayer
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setIframeMode("direct")}
                className={`px-3 py-1 rounded-lg border text-sm ${iframeMode === "direct" ? "border-blue-500 text-blue-400" : "border-gray-700"}`}
              >
                Direct
              </button>
              <button
                onClick={() => setIframeMode("proxy")}
                className={`px-3 py-1 rounded-lg border text-sm ${iframeMode === "proxy" ? "border-blue-500 text-blue-400" : "border-gray-700"}`}
              >
                Via embed-proxy
              </button>
              <button
                onClick={() => setIframeMode("proxy_stable")}
                className={`px-3 py-1 rounded-lg border text-sm ${iframeMode === "proxy_stable" ? "border-blue-500 text-blue-400" : "border-gray-700"}`}
              >
                Proxy + stable
              </button>
            </div>

            <div className="text-xs text-gray-400 break-words">Resolved URL: {resolvedIframeUrl || "-"}</div>
          </div>

          <div className="mt-4 aspect-video rounded-xl overflow-hidden border border-gray-800 bg-black">
            {resolvedIframeUrl ? (
              <iframe
                src={resolvedIframeUrl}
                className="w-full h-full"
                allowFullScreen
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock"
                title="Iframe Test"
              />
            ) : (
              <div className="h-full flex items-center justify-center text-gray-500 text-sm">Enter a valid URL</div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-gray-800 bg-[#111] p-4">
          <h2 className="text-lg font-bold mb-3">HLS Test (m3u8)</h2>

          <div className="grid gap-3">
            <input
              value={hlsUrl}
              onChange={(e) => setHlsUrl(e.target.value)}
              className="w-full rounded-lg bg-black border border-gray-700 p-2 text-sm"
              placeholder="M3U8 URL"
            />
            <input
              value={hlsRef}
              onChange={(e) => setHlsRef(e.target.value)}
              className="w-full rounded-lg bg-black border border-gray-700 p-2 text-sm"
              placeholder="Referrer URL (for proxy mode)"
            />

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setHlsMode("direct")}
                className={`px-3 py-1 rounded-lg border text-sm ${hlsMode === "direct" ? "border-blue-500 text-blue-400" : "border-gray-700"}`}
              >
                Direct
              </button>
              <button
                onClick={() => setHlsMode("proxy")}
                className={`px-3 py-1 rounded-lg border text-sm ${hlsMode === "proxy" ? "border-blue-500 text-blue-400" : "border-gray-700"}`}
              >
                Via proxy
              </button>
            </div>

            <div className="text-xs text-gray-400 break-words">Resolved URL: {resolvedHlsUrl || "-"}</div>
          </div>

          <div className="mt-4">
            <video ref={videoRef} controls className="w-full rounded-xl border border-gray-800 bg-black" />
          </div>

          <div className="mt-4 rounded-xl border border-gray-800 bg-black p-3">
            <div className="font-bold text-sm mb-2">HLS Logs</div>
            <div className="text-xs text-gray-300 space-y-1 max-h-56 overflow-auto">
              {hlsLogs.length ? (
                hlsLogs.map((line, idx) => <div key={`${line}-${idx}`}>{line}</div>)
              ) : (
                <div className="text-gray-500">No logs yet.</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
