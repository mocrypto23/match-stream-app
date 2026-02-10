import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROXY_DEPTH = 4;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const BLOCKED_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adservice.google.com",
  "taboola.com",
  "outbrain.com",
  "mgid.com",
  "propellerads.com",
  "popads.net",
  "onclickalgo.com",
  "pushwelcome.com",
  "pushpushgo.com",
  "hilltopads.net",
  "identitylumber.com",
  "adsco.re",
  "dishtrainer.net",
  "intellipopup.com",
  "blockadsnot.com",
  "adexchangeclear.com",
  "usrpubtrk.com",
  "histats.com",
  "histats.net",
  "trafficstars.com",
  "ero-advertising.com",
  "juicyads.com",
  "exoclick.com",
  "adnxs.com",
  "criteo.com",
  "adform.net",
  "rtbhouse.com",
  "bidvertiser.com",
  "protrafficinspector.com",
  "bvtpk.com",
  "cloudflareinsights.com",
  "theajack.github.io",
  "dtscout.com",
  "dtscdn.com",
  "crwdcntrl.net",
  "awistats.com",
  "rtmark.net",
  "255md.com",
  "whos.amung.us",
  "cldnpegyfstse.space",
];

const BLOCKED_KEYWORDS = [
  "porn",
  "xxx",
  "xnxx",
  "xvideos",
  "redtube",
  "hentai",
  "camgirl",
  "cam4",
  "adult",
  "disable-devtool",
  "disable-devtools",
  "cdn-cgi/zaraz",
  "/adc/",
  "dtscout",
  "crwdcntrl",
  "awistats",
  "rtmark",
  "googletagmanager",
  "google-analytics",
  "amung",
  "iclick-v1",
];

const STREAM_HOST_ALLOW_SUFFIXES = [
  "dishtrainer.net",
  "koora-stream.top",
  "alkoora.live",
  "livehd77.pro",
  "bein-live.com",
  "lifekora.com",
  "taktikora.live",
  "popcdn.day",
  "lovetier.bz",
  "sportzonline.click",
  "dynamicsafari.net",
  "lovecdn.ru",
  "pandalive.live",
];

const DEFAULT_DIRECT_HOST_SUFFIXES = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "cdn.radiantmediatechs.com",
  "fonts.gstatic.com",
  "fonts.googleapis.com",
];

const HOST_LOCK_BYPASS_SUFFIXES = ["yallashoot2026.net"];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const ALLOWED_HOST_SUFFIXES = String(process.env.EMBED_PROXY_ALLOWED_HOSTS || "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const STREAM_HOST_ALLOWLIST_FROM_ENV = String(process.env.EMBED_PROXY_STREAM_ALLOW_HOSTS || "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const STREAM_HOST_DIRECT_FROM_ENV = String(process.env.EMBED_PROXY_DIRECT_HOSTS || "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const STREAM_HOST_DIRECT_SUFFIXES = Array.from(
  new Set([...DEFAULT_DIRECT_HOST_SUFFIXES, ...STREAM_HOST_DIRECT_FROM_ENV])
);

const M3U8_CACHE_TTL_MS = Math.max(
  0,
  Number.parseInt(process.env.EMBED_PROXY_M3U8_CACHE_TTL_MS || "2500", 10) || 2500
);
const M3U8_CACHE_MAX_ENTRIES = Math.max(
  32,
  Number.parseInt(process.env.EMBED_PROXY_M3U8_CACHE_MAX_ENTRIES || "300", 10) || 300
);

type ManifestCacheEntry = {
  body: string;
  expiresAt: number;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
};

const manifestCache = new Map<string, ManifestCacheEntry>();

function normalizeHost(host: string) {
  return String(host || "").trim().toLowerCase().replace(/\.$/, "");
}

function hostMatchesAny(host: string, suffixes: string[]) {
  const h = normalizeHost(host);
  return suffixes.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

function isPrivateHost(hostname: string) {
  const host = normalizeHost(hostname);
  if (!host) return true;

  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  const ipv4 = host.match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (ipv4) {
    const parts = host.split(".").map((x) => Number.parseInt(x, 10));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;

    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }

  // Best-effort IPv6 private/link-local filtering.
  const raw = host.replace(/^\[|\]$/g, "");
  if (raw.includes(":")) {
    if (raw === "::1") return true;
    if (raw.startsWith("fc") || raw.startsWith("fd") || raw.startsWith("fe80")) return true;
  }

  return false;
}

function hasBlockedKeyword(value: string) {
  const s = String(value || "").toLowerCase();
  return BLOCKED_KEYWORDS.some((k) => s.includes(k));
}

function isAllowedStreamHost(host: string) {
  return hostMatchesAny(host, [...STREAM_HOST_ALLOW_SUFFIXES, ...STREAM_HOST_ALLOWLIST_FROM_ENV]);
}

function shouldKeepDirectHost(host: string) {
  return hostMatchesAny(host, STREAM_HOST_DIRECT_SUFFIXES);
}

function isBlockedAbsoluteUrl(absUrl: string) {
  try {
    const u = new URL(absUrl);
    const host = normalizeHost(u.hostname);
    const hay = `${host}${u.pathname}${u.search}`.toLowerCase();
    if (isAllowedStreamHost(host)) return hasBlockedKeyword(`${u.pathname}${u.search}`);
    return hostMatchesAny(host, BLOCKED_HOST_SUFFIXES) || hasBlockedKeyword(hay);
  } catch {
    return hasBlockedKeyword(absUrl);
  }
}

function toAbsoluteUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.startsWith("#")) return null;
  if (/^(javascript:|data:|blob:|mailto:|tel:)/i.test(value)) return null;
  try {
    const abs = new URL(value, baseUrl);
    if (!/^https?:$/i.test(abs.protocol)) return null;
    return abs.toString();
  } catch {
    return null;
  }
}

function buildProxyUrl(absUrl: string, nextDepth: number, refUrl?: string | null) {
  const refPart = refUrl ? `&ref=${encodeURIComponent(refUrl)}` : "";
  return `/api/embed-proxy?url=${encodeURIComponent(absUrl)}&depth=${nextDepth}${refPart}`;
}

function rewriteAttributeUrls(html: string, baseUrl: string, depth: number) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const attrs = ["src", "href", "action", "data-src", "poster"];

  let out = html;
  for (const attr of attrs) {
    const re = new RegExp(`(${attr}\\s*=\\s*["'])([^"']+)(["'])`, "gi");
    out = out.replace(re, (_full, prefix: string, rawValue: string, suffix: string) => {
      const absolute = toAbsoluteUrl(rawValue, baseUrl);
      if (!absolute) return `${prefix}${rawValue}${suffix}`;

      if (isBlockedAbsoluteUrl(absolute)) {
        return attr === "href"
          ? `${prefix}javascript:void(0)${suffix}`
          : `${prefix}about:blank${suffix}`;
      }

      let rewritten = absolute;
      try {
        const maybeProxy = new URL(absolute);
        const host = normalizeHost(maybeProxy.hostname);
        const keepDirect = shouldKeepDirectHost(host);
        if (!keepDirect && maybeProxy.pathname !== "/api/embed-proxy" && depth < MAX_PROXY_DEPTH) {
          rewritten = buildProxyUrl(absolute, nextDepth, baseUrl);
        }
      } catch {}

      return `${prefix}${rewritten}${suffix}`;
    });
  }

  return out;
}

function rewriteSrcsetUrls(html: string, baseUrl: string, depth: number) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const re = /(srcset\s*=\s*["'])([^"']+)(["'])/gi;

  return html.replace(re, (_full, prefix: string, rawValue: string, suffix: string) => {
    const rewritten = rawValue
      .split(",")
      .map((part) => part.trim())
      .map((part) => {
        const pieces = part.split(/\s+/);
        const rawUrl = pieces.shift() || "";
        const descriptor = pieces.join(" ");
        const absolute = toAbsoluteUrl(rawUrl, baseUrl);
        if (!absolute || isBlockedAbsoluteUrl(absolute)) return null;
        let finalUrl = absolute;
        try {
          const host = normalizeHost(new URL(absolute).hostname);
          if (!shouldKeepDirectHost(host) && depth < MAX_PROXY_DEPTH) {
            finalUrl = buildProxyUrl(absolute, nextDepth, baseUrl);
          }
        } catch {}
        return descriptor ? `${finalUrl} ${descriptor}` : finalUrl;
      })
      .filter(Boolean);

    if (!rewritten.length) return `${prefix}${rawValue}${suffix}`;
    return `${prefix}${rewritten.join(", ")}${suffix}`;
  });
}

function rewriteCssUrls(css: string, baseUrl: string, depth: number) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  let out = String(css || "");

  out = out.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_full, quote: string, rawValue: string) => {
    const absolute = toAbsoluteUrl(rawValue, baseUrl);
    if (!absolute) return `url(${quote}${rawValue}${quote})`;
    if (isBlockedAbsoluteUrl(absolute)) return "url(about:blank)";

    let rewritten = absolute;
    try {
      const host = normalizeHost(new URL(absolute).hostname);
      if (!shouldKeepDirectHost(host) && depth < MAX_PROXY_DEPTH) {
        rewritten = buildProxyUrl(absolute, nextDepth, baseUrl);
      }
    } catch {}

    return `url("${rewritten}")`;
  });

  out = out.replace(
    /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi,
    (_full, quote: string, rawValue: string) => {
      const absolute = toAbsoluteUrl(rawValue, baseUrl);
      if (!absolute) return `@import ${quote}${rawValue}${quote}`;
      if (isBlockedAbsoluteUrl(absolute)) return "@import url(about:blank)";

      let rewritten = absolute;
      try {
        const host = normalizeHost(new URL(absolute).hostname);
        if (!shouldKeepDirectHost(host) && depth < MAX_PROXY_DEPTH) {
          rewritten = buildProxyUrl(absolute, nextDepth, baseUrl);
        }
      } catch {}

      return `@import url("${rewritten}")`;
    }
  );

  return out;
}

function isLikelyM3u8(target: URL, contentType: string) {
  const ct = String(contentType || "").toLowerCase();
  const path = String(target.pathname || "").toLowerCase();
  return (
    path.endsWith(".m3u8") ||
    ct.includes("application/vnd.apple.mpegurl") ||
    ct.includes("application/x-mpegurl") ||
    ct.includes("audio/mpegurl") ||
    ct.includes("audio/x-mpegurl")
  );
}

function rewriteM3u8Manifest(
  manifest: string,
  baseUrl: string,
  depth: number,
  referrerForChildren?: string | null
) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const childReferrer = referrerForChildren || baseUrl;

  const toProxyUri = (raw: string) => {
    const absolute = toAbsoluteUrl(raw, baseUrl);
    if (!absolute) return raw;
    if (isBlockedAbsoluteUrl(absolute)) return raw;
    return buildProxyUrl(absolute, nextDepth, childReferrer);
  };

  const lines = String(manifest || "").split(/\r?\n/);

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        // Handle tags like: #EXT-X-KEY:METHOD=AES-128,URI="key.key"
        return line.replace(/URI=(["'])([^"']+)\1/gi, (_full, quote: string, rawUri: string) => {
          const rewritten = toProxyUri(rawUri);
          return `URI=${quote}${rewritten}${quote}`;
        });
      }

      return toProxyUri(trimmed);
    })
    .join("\n");
}

function shouldUseManifestCacheForTarget(target: URL) {
  const value = `${target.pathname}${target.search}`.toLowerCase();
  return value.includes(".m3u8");
}

function buildManifestCacheKey(target: URL, depth: number, safeReferrer?: string | null) {
  return `${target.toString()}|d=${depth}|r=${safeReferrer || ""}`;
}

function trimManifestCache(now = Date.now()) {
  for (const [key, value] of manifestCache) {
    if (value.expiresAt <= now) manifestCache.delete(key);
  }

  while (manifestCache.size > M3U8_CACHE_MAX_ENTRIES) {
    const firstKey = manifestCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    manifestCache.delete(firstKey);
  }
}

function buildInjection(depth: number, currentTargetUrl: string, stableMode: boolean) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const blockedHosts = JSON.stringify(BLOCKED_HOST_SUFFIXES);
  const blockedWords = JSON.stringify(BLOCKED_KEYWORDS);
  const allowedHosts = JSON.stringify([...STREAM_HOST_ALLOW_SUFFIXES, ...STREAM_HOST_ALLOWLIST_FROM_ENV]);
  const directHosts = JSON.stringify(STREAM_HOST_DIRECT_SUFFIXES);
  const currentTarget = JSON.stringify(currentTargetUrl);
  const stableModeJson = stableMode ? "true" : "false";

  return `
<style>
  html, body {
    background: #000 !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
  }
  .aplr-player-wrapper, .aplr-player-content, .video-con, .embed-responsive, .server_container {
    width: 100% !important;
    max-width: 100% !important;
  }
  .aplr-menu, .servers_list {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .aplr-menu { overflow-x: auto !important; }
  iframe, video { max-width: 100% !important; }
  .popup, .popunder, .adsbox, .ad-container, .adsbygoogle,
  [class*="popup"], [id*="popup"],
  iframe[src*="adsco.re"], iframe[src*="intellipopup.com"], iframe[src*="blockadsnot.com"] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
</style>
<script>
(() => {
  const blockedHosts = ${blockedHosts};
  const blockedWords = ${blockedWords};
  const allowedHosts = ${allowedHosts};
  const directHosts = ${directHosts};
  const currentTargetUrl = ${currentTarget};
  const stableMode = ${stableModeJson};
  const proxyPath = "/api/embed-proxy";
  const nextDepth = ${nextDepth};
  const maxDepth = ${MAX_PROXY_DEPTH};

  const emitDiag = (event, data) => {
    try {
      const payload = {
        type: "__embed_proxy_diag",
        event: String(event || ""),
        data: data || {},
        href: location.href,
        target: currentTargetUrl,
        ts: Date.now(),
      };
      if (window.top && typeof window.top.postMessage === "function") {
        window.top.postMessage(payload, "*");
      } else if (window.parent && typeof window.parent.postMessage === "function") {
        window.parent.postMessage(payload, "*");
      }
    } catch {}
  };
  window.__embedProxyDiag = emitDiag;
  emitDiag("proxy_boot", { stableMode, nextDepth });

  const hostAllowed = (host) => {
    const h = String(host || "").toLowerCase();
    return allowedHosts.some((suffix) => h === suffix || h.endsWith("." + suffix));
  };
  
  const hostDirect = (host) => {
    const h = String(host || "").toLowerCase();
    return directHosts.some((suffix) => h === suffix || h.endsWith("." + suffix));
  };

  const hostBlocked = (host) => {
    const h = String(host || "").toLowerCase();
    return blockedHosts.some((suffix) => h === suffix || h.endsWith("." + suffix));
  };

  const hasBadWord = (value) => {
    const s = String(value || "").toLowerCase();
    return blockedWords.some((w) => s.includes(w));
  };

  const isBlocked = (urlLike) => {
    try {
      const u = new URL(String(urlLike), currentTargetUrl);
      if (hostAllowed(u.hostname)) return hasBadWord(u.pathname + u.search);
      const hay = (u.hostname + u.pathname + u.search).toLowerCase();
      return hostBlocked(u.hostname) || hasBadWord(hay);
    } catch {
      return hasBadWord(String(urlLike || ""));
    }
  };

  const toProxy = (urlLike) => {
    try {
      const raw = String(urlLike || "").trim();
      if (!raw) return null;
      if (raw.startsWith(proxyPath) || raw.startsWith(location.origin + proxyPath)) return raw;
      let normalizedRaw = raw;
      const lowerNormalizedRaw = normalizedRaw.toLowerCase();
      const startsAsLocal =
        lowerNormalizedRaw.startsWith("http://localhost") ||
        lowerNormalizedRaw.startsWith("https://localhost") ||
        lowerNormalizedRaw.startsWith("http//localhost") ||
        lowerNormalizedRaw.startsWith("https//localhost");
      if (!startsAsLocal && lowerNormalizedRaw.includes("localhost")) return null;
      const localCandidates = [
        lowerNormalizedRaw.indexOf("http://localhost"),
        lowerNormalizedRaw.indexOf("https://localhost"),
        lowerNormalizedRaw.indexOf("http//localhost"),
        lowerNormalizedRaw.indexOf("https//localhost"),
      ].filter((idx) => idx > 0);
      const localIndex = localCandidates.length ? Math.min(...localCandidates) : -1;

      if (localIndex > 0) {
        let prefix = normalizedRaw.slice(0, localIndex);
        while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);

        const localPart = normalizedRaw.slice(localIndex);
        const localPartLower = localPart.toLowerCase();
        const hostStart = localPartLower.indexOf("localhost");
        const slashAfterHost = localPart.indexOf("/", hostStart >= 0 ? hostStart + "localhost".length : 0);
        const tail = slashAfterHost >= 0 ? localPart.slice(slashAfterHost + 1) : "";

        if (prefix && tail) {
          normalizedRaw = prefix + "/" + tail;
        }
      }
      try {
        const rawAbs = new URL(raw, location.href);
        const targetOrigin = new URL(currentTargetUrl).origin;
        if (rawAbs.origin === location.origin && rawAbs.pathname !== proxyPath && targetOrigin) {
          normalizedRaw = targetOrigin + rawAbs.pathname + rawAbs.search + rawAbs.hash;
        }
      } catch {}

      const abs = new URL(normalizedRaw, currentTargetUrl);
      if (!/^https?:$/i.test(abs.protocol)) return null;
      if (abs.pathname === proxyPath && abs.origin === location.origin) return abs.toString();
      if (hostDirect(abs.hostname)) return abs.toString();
      if (isBlocked(abs.toString())) return null;
      if (nextDepth > maxDepth) return abs.toString();
      return (
        proxyPath +
        "?url=" +
        encodeURIComponent(abs.toString()) +
        "&depth=" +
        nextDepth +
        "&ref=" +
        encodeURIComponent(currentTargetUrl)
      );
    } catch {
      return null;
    }
  };

  window.__embedProxyWrap = (urlLike) => {
    const rewritten = toProxy(urlLike);
    return rewritten || urlLike;
  };

  const patchMediaApis = () => {
    // Hook Clappr player source assignment.
    const patchClappr = (clapprObj) => {
      try {
        if (!clapprObj || clapprObj.__embedProxyPatched) return;
        const originalPlayer = clapprObj.Player;
        if (typeof originalPlayer !== "function") return;

        const wrappedPlayer = new Proxy(originalPlayer, {
          construct(target, args, newTarget) {
            try {
              if (args && args[0] && typeof args[0].source === "string") {
                const rewritten = toProxy(args[0].source);
                if (rewritten) args[0].source = rewritten;
              }
            } catch {}
            return Reflect.construct(target, args, newTarget);
          },
          apply(target, thisArg, args) {
            try {
              if (args && args[0] && typeof args[0].source === "string") {
                const rewritten = toProxy(args[0].source);
                if (rewritten) args[0].source = rewritten;
              }
            } catch {}
            return Reflect.apply(target, thisArg, args);
          },
        });

        clapprObj.Player = wrappedPlayer;
        clapprObj.__embedProxyPatched = true;
      } catch {}
    };

    // Hook Hls.js loadSource.
    const patchHls = () => {
      try {
        const HlsCtor = window.Hls;
        if (!HlsCtor || HlsCtor.__embedProxyPatched) return;
        if (!HlsCtor.prototype || typeof HlsCtor.prototype.loadSource !== "function") return;
        const originalLoadSource = HlsCtor.prototype.loadSource;
        HlsCtor.prototype.loadSource = function (urlLike) {
          const rewritten = toProxy(urlLike);
          return originalLoadSource.call(this, rewritten || urlLike);
        };
        HlsCtor.__embedProxyPatched = true;
      } catch {}
    };

    // Hook media src setter (video/audio/source).
    const patchMediaSrcSetter = () => {
      try {
        const proto = HTMLMediaElement && HTMLMediaElement.prototype;
        if (!proto || proto.__embedProxySrcPatched) return;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
        if (!descriptor || typeof descriptor.set !== "function" || typeof descriptor.get !== "function") return;

        Object.defineProperty(proto, "src", {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {
            try {
              const rewritten = toProxy(value);
              return descriptor.set.call(this, rewritten || value);
            } catch {
              return descriptor.set.call(this, value);
            }
          },
        });
        proto.__embedProxySrcPatched = true;
      } catch {}
    };

    try {
      let clapprRef = window.Clappr;
      Object.defineProperty(window, "Clappr", {
        configurable: true,
        enumerable: true,
        get() {
          return clapprRef;
        },
        set(value) {
          clapprRef = value;
          patchClappr(value);
        },
      });
      if (clapprRef) patchClappr(clapprRef);
    } catch {
      patchClappr(window.Clappr);
    }

    patchHls();
    patchMediaSrcSetter();

    setInterval(() => {
      patchClappr(window.Clappr);
      patchHls();
      patchMediaSrcSetter();
    }, 700);
  };

  const lockPopupApis = () => {
    try { window.open = () => null; } catch {}
    try { window.alert = () => {}; } catch {}
    try { window.confirm = () => false; } catch {}
    try { window.prompt = () => null; } catch {}
    try {
      Object.defineProperty(window, "onbeforeunload", {
        configurable: false,
        get: () => null,
        set: () => null
      });
    } catch {}
  };

  const stripBadNodes = () => {
    const obvious = document.querySelectorAll(
      ".popup, .popunder, .adsbox, .ad-container, .adsbygoogle, [class*='popup'], [id*='popup']"
    );
    for (const el of obvious) {
      try { el.remove(); } catch {}
    }

    const netNodes = document.querySelectorAll("iframe[src], script[src], a[href], source[src], video[src]");
    for (const el of netNodes) {
      const raw = el.getAttribute("src") || el.getAttribute("href") || "";
      if (!raw) continue;
      if (!isBlocked(raw)) continue;
      const tag = el.tagName.toLowerCase();
      try {
        if (tag === "a") {
          el.setAttribute("href", "javascript:void(0)");
          el.setAttribute("target", "_self");
        } else {
          el.setAttribute("src", "about:blank");
        }
      } catch {}
    }

  };

  const rewriteToProxy = () => {
    const attrs = [
      ["iframe[src]", "src"],
      ["iframe[data-src]", "data-src"],
      ["script[src]", "src"],
      ["link[href]", "href"],
      ["source[src]", "src"],
      ["video[src]", "src"]
    ];
    for (const pair of attrs) {
      const selector = pair[0];
      const attr = pair[1];
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const raw = node.getAttribute(attr);
        if (!raw) continue;
        const rewritten = toProxy(raw);
        if (!rewritten || rewritten === raw) continue;
        try { node.setAttribute(attr, rewritten); } catch {}
      }
    }
  };

  const interceptNetworkApis = () => {
    const patchFetch = () => {
      try {
        if (window.fetch && window.fetch.__embedProxyPatched) return;
        const nativeFetch = window.fetch.bind(window);
        const wrappedFetch = (input, init) => {
          try {
            if (typeof input === "string" || input instanceof URL) {
              const raw = String(input);
              const rewritten = toProxy(raw);
              if (rewritten && rewritten !== raw) return nativeFetch(rewritten, init);
            } else if (input instanceof Request) {
              const rewritten = toProxy(input.url);
              if (rewritten && rewritten !== input.url) {
                return nativeFetch(new Request(rewritten, input), init);
              }
            }
          } catch {}
          return nativeFetch(input, init);
        };
        wrappedFetch.__embedProxyPatched = true;
        wrappedFetch.__embedProxyNative = nativeFetch;
        window.fetch = wrappedFetch;
      } catch {}
    };

    const patchXhrPrototype = () => {
      try {
        if (!window.XMLHttpRequest || !window.XMLHttpRequest.prototype) return;
        const proto = window.XMLHttpRequest.prototype;
        if (proto.open && proto.open.__embedProxyPatched) return;

        const nativeOpen = proto.open;
        const wrappedOpen = function (...args) {
          try {
            if (args.length >= 2) {
              const raw = String(args[1] ?? "");
              const rewritten = toProxy(raw);
              if (rewritten && rewritten !== raw) args[1] = rewritten;
            }
          } catch {}
          return nativeOpen.apply(this, args);
        };
        wrappedOpen.__embedProxyPatched = true;
        wrappedOpen.__embedProxyNative = nativeOpen;
        proto.open = wrappedOpen;
      } catch {}
    };

    const patchXhrConstructor = () => {
      try {
        if (!window.XMLHttpRequest || window.XMLHttpRequest.__embedProxyCtorPatched) return;
        const NativeXHR = window.XMLHttpRequest;

        const WrappedXHR = new Proxy(NativeXHR, {
          construct(target, args, newTarget) {
            const xhr = Reflect.construct(target, args, newTarget);
            try {
              const nativeOpen = xhr.open;
              xhr.open = function (...openArgs) {
                try {
                  if (openArgs.length >= 2) {
                    const raw = String(openArgs[1] ?? "");
                    const rewritten = toProxy(raw);
                    if (rewritten && rewritten !== raw) openArgs[1] = rewritten;
                  }
                } catch {}
                return nativeOpen.apply(this, openArgs);
              };
            } catch {}
            return xhr;
          },
          apply(target, thisArg, args) {
            return Reflect.apply(target, thisArg, args);
          },
        });

        WrappedXHR.__embedProxyCtorPatched = true;
        WrappedXHR.__embedProxyNative = NativeXHR;
        window.XMLHttpRequest = WrappedXHR;
      } catch {}
    };

    const applyAll = () => {
      patchFetch();
      patchXhrPrototype();
      patchXhrConstructor();
    };

    applyAll();
    setInterval(applyAll, 500);
  };

  const enforceStableServerMode = () => {
    if (!stableMode) return;

    let path = "";
    try {
      path = new URL(currentTargetUrl).pathname.toLowerCase();
      if (!path.includes("/albaplayer/") && !path.includes("/alba.php")) return;
    } catch {
      return;
    }

    const fallbackServ = path.includes("/ad-sport-2/") ? "5" : "2";
    const allowedServ = path.includes("/ad-sport-2/")
      ? new Set(["4", "5"])
      : new Set(["2", "5"]);
    const menuLinks = document.querySelectorAll(".aplr-menu .aplr-link");

    for (const link of menuLinks) {
      const href = link.getAttribute("href") || "";
      let keep = false;
      try {
        const u = new URL(href, currentTargetUrl);
        const serv = (u.searchParams.get("serv") || "").trim();
        keep = allowedServ.has(serv);
      } catch {}
      const parent = link.closest("li");
      if (parent) {
        parent.style.display = keep ? "" : "none";
      }
    }

    const currentServ = (() => {
      try {
        return new URL(currentTargetUrl).searchParams.get("serv");
      } catch {
        return null;
      }
    })();

    if (currentServ && !allowedServ.has(String(currentServ))) {
      try {
        const u = new URL(currentTargetUrl);
        u.searchParams.set("serv", fallbackServ);
        const proxied = toProxy(u.toString());
        location.replace(proxied || u.toString());
      } catch {}
    }

    document.addEventListener(
      "click",
      (ev) => {
        const target = ev.target;
        if (!target || typeof target.closest !== "function") return;
        const a = target.closest(".aplr-menu .aplr-link");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        try {
          const u = new URL(href, currentTargetUrl);
          const serv = (u.searchParams.get("serv") || "").trim();
          if (allowedServ.has(serv)) return;
          ev.preventDefault();
          ev.stopPropagation();
          if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        } catch {}
      },
      true
    );
  };

  const onClickCapture = (ev) => {
    const t = ev.target;
    if (!t || typeof t.closest !== "function") return;
    const anchor = t.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (!isBlocked(href)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;

    enforceStableServerMode();
    rewriteToProxy();
    stripBadNodes();

    document.addEventListener("click", onClickCapture, true);
    setInterval(() => {
      rewriteToProxy();
      stripBadNodes();
    }, 1200);

    const observer = new MutationObserver(() => {
      rewriteToProxy();
      stripBadNodes();
    });

    observer.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "href", "data-src", "class", "style", "id"]
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
  lockPopupApis();
  interceptNetworkApis();
  patchMediaApis();
  start();
})();
</script>
`;
}

function injectProtection(html: string, snippet: string) {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${snippet}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${snippet}`);
  return `${snippet}${html}`;
}

function bypassHostLockChecks(html: string, target: URL) {
  const host = normalizeHost(target.hostname);
  if (!hostMatchesAny(host, HOST_LOCK_BYPASS_SUFFIXES)) return html;

  return String(html || "")
    .replace(/if\s*\(\s*window\.location\.hostname\s*!==\s*h\s*\)\s*return\s*;?/gi, "")
    .replace(/if\s*\(\s*window\.location\.hostname\s*!=\s*h\s*\)\s*return\s*;?/gi, "")
    .replace(/if\s*\(\s*window\.location\.hostname\s*!==\s*["'][^"']+["']\s*\)\s*return\s*;?/gi, "");
}

function appendBeforeBody(html: string, snippet: string) {
  if (!snippet) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${snippet}</body>`);
  return `${html}${snippet}`;
}

function extractM3u8UrlsFromText(input: string) {
  const out: string[] = [];
  const re = /https?:\/\/[^"'`\s<>()]+\.m3u8[^"'`\s<>()]*/gi;
  for (const m of String(input || "").matchAll(re)) {
    const raw = String(m[0] || "").trim();
    if (!raw) continue;
    try {
      out.push(new URL(raw).toString());
    } catch {}
  }
  return Array.from(new Set(out));
}

function decodeSimpleJsString(input: string) {
  return String(input || "")
    .replace(/\\\\/g, "\\")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function extractM3u8UrlsFromPackedEvalScripts(html: string) {
  const out: string[] = [];
  const packedRe =
    /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'([\s\S]*?)'\.split\('\|'\)/gi;

  let match: RegExpExecArray | null = null;
  while ((match = packedRe.exec(String(html || "")))) {
    const payload = decodeSimpleJsString(match[1]);
    const radix = Number.parseInt(String(match[2]), 10);
    const dict = decodeSimpleJsString(match[3]).split("|");

    if (!payload || !Number.isFinite(radix) || radix < 2 || radix > 36 || !dict.length) continue;

    const decoded = payload.replace(/\b[0-9a-z]+\b/gi, (token) => {
      const idx = Number.parseInt(token.toLowerCase(), radix);
      if (!Number.isFinite(idx) || idx < 0 || idx >= dict.length) return token;
      const mapped = String(dict[idx] || "").trim();
      return mapped || token;
    });

    out.push(...extractM3u8UrlsFromText(decoded));
  }

  return Array.from(new Set(out));
}

function buildManualHlsFallbackSnippet({
  candidates,
  referrer,
  depth,
}: {
  candidates: string[];
  referrer: string;
  depth: number;
}) {
  const uniqueCandidates = Array.from(new Set((candidates || []).filter(Boolean)));
  if (!uniqueCandidates.length) return "";

  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const hlsLibUrl = buildProxyUrl("https://cdn.jsdelivr.net/npm/hls.js@latest", nextDepth, referrer);

  return `
<script>
(() => {
  const candidates = ${JSON.stringify(uniqueCandidates)};
  const fallbackRef = ${JSON.stringify(referrer)};
  const hlsLibUrl = ${JSON.stringify(hlsLibUrl)};
  let video = null;
  let hls = null;
  let currentIndex = 0;
  let switchedAfterFatal = false;

  const toProxyWrap = (u) => {
    try {
      const abs = new URL(String(u || ""), fallbackRef);
      return "/api/embed-proxy?url=" + encodeURIComponent(abs.toString()) + "&depth=0&ref=" + encodeURIComponent(fallbackRef);
    } catch {
      return null;
    }
  };

  const emitDiag = (event, data) => {
    try {
      if (typeof window.__embedProxyDiag === "function") {
        window.__embedProxyDiag(event, data || {});
        return;
      }
    } catch {}
    try {
      window.top?.postMessage({
        type: "__embed_proxy_diag",
        event,
        data: data || {},
        href: location.href,
        ts: Date.now(),
      }, "*");
    } catch {}
  };

  const ensureHls = async () => {
    if (window.Hls) return true;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = hlsLibUrl;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error("hls.js load failed"));
      document.head.appendChild(s);
    });
    return !!window.Hls;
  };

  const mountRoot = () => {
    return (
      document.querySelector("#player") ||
      document.querySelector("#clappr-player") ||
      document.querySelector(".player-container") ||
      document.querySelector(".video-con") ||
      document.querySelector(".aplr-player-content") ||
      document.body
    );
  };

  const destroyHls = () => {
    if (!hls) return;
    try { hls.destroy(); } catch {}
    hls = null;
  };

  const ensureVideo = () => {
    if (video && video.isConnected) return video;
    const root = mountRoot();
    if (!root) return null;

    video = document.getElementById("embed-proxy-manual-hls");
    if (!video) {
      video = document.createElement("video");
      video.id = "embed-proxy-manual-hls";
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.background = "#000";
    }

    const isVideoRoot =
      root.id === "player" ||
      root.id === "clappr-player" ||
      root.classList?.contains("video-con") ||
      root.classList?.contains("player-container");
    if (isVideoRoot) root.innerHTML = "";
    if (!video.isConnected) root.prepend(video);
    return video;
  };

  const playSource = async (source) => {
    const v = ensureVideo();
    if (!v || !source) return false;

    if (v.canPlayType("application/vnd.apple.mpegurl")) {
      destroyHls();
      v.src = source;
      await v.play().catch(() => {});
      return true;
    }

    const ok = await ensureHls().catch(() => false);
    if (!ok || !window.Hls || !window.Hls.isSupported()) {
      destroyHls();
      v.src = source;
      await v.play().catch(() => {});
      return true;
    }

    destroyHls();
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: 18,
      maxMaxBufferLength: 24,
      backBufferLength: 12,
      liveSyncDurationCount: 3,
    });
    window.__embedProxyManualHls = hls;
    hls.attachMedia(v);
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(source));
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_ev, data) => {
      try {
        emitDiag("manual_hls_error", {
          idx: currentIndex,
          type: data?.type || "",
          details: data?.details || "",
          fatal: !!data?.fatal,
        });
      } catch {
        return;
      }
      if (!data?.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        try { hls.startLoad(); } catch {}
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch {}
        return;
      }
      if (!switchedAfterFatal && candidates.length > 1) {
        switchedAfterFatal = true;
        currentIndex = (currentIndex + 1) % candidates.length;
        emitDiag("manual_hls_fallback_once", { idx: currentIndex });
        startCurrent().catch(() => {});
      }
    });
    return true;
  };

  const startCurrent = async () => {
    if (!candidates.length) return false;
    const rawCandidate = candidates[currentIndex];
    const source = toProxyWrap(rawCandidate);
    if (!source) return false;
    emitDiag("manual_hls_play_source", { idx: currentIndex, source });
    return playSource(source);
  };

  const pickInitialIndex = async () => {
    for (let i = 0; i < candidates.length; i++) {
      const proxied = toProxyWrap(candidates[i]);
      if (!proxied) continue;
      try {
        const res = await fetch(proxied, { method: "GET", cache: "no-store" });
        if (!res.ok) continue;
        const txt = await res.text();
        if (txt && txt.indexOf("#EXTM3U") !== -1) return i;
      } catch {}
    }
    return 0;
  };

  const boot = async () => {
    ensureVideo();
    currentIndex = await pickInitialIndex();
    await startCurrent();
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (video && video.currentSrc) video.play().catch(() => {});
    if (hls && typeof hls.startLoad === "function") {
      try { hls.startLoad(); } catch {}
    }
  });

  setTimeout(() => { boot().catch(() => {}); }, 80);
})();
</script>`;
}

function rewriteKnownInlineEndpoints(html: string, target: URL, depth: number) {
  let out = String(html || "");
  const host = normalizeHost(target.hostname);
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);

  // Kill common anti-debug loaders that redirect/blank the player.
  out = out.replace(
    /<script[^>]+src=["'][^"']*disable-devtools[^"']*["'][^>]*>\s*<\/script>/gi,
    ""
  );
  out = out.replace(
    /if\s*\(\s*typeof\s+DisableDevtool\s*!==\s*['"]undefined['"]\s*\)\s*\{[\s\S]*?\}/gi,
    ""
  );
  out = out.replace(/DisableDevtool\s*\([\s\S]*?\)\s*;?/gi, "");
  out = out.replace(/consoleban\.init\s*\([\s\S]*?\)\s*;?/gi, "");

  // yallashot player requires this POST endpoint to generate stream tokens.
  if (host.endsWith("yallashot.us")) {
    const tokenEndpoint = `${target.origin}/playerv2.php?action=generate_token`;
    const proxiedTokenEndpoint = buildProxyUrl(tokenEndpoint, nextDepth, target.toString());
    out = out.replace(
      /(['"])(?:\/)?playerv2\.php\?action=generate_token([^"']*)\1/gi,
      (_full, quote: string, suffix: string) => `${quote}${proxiedTokenEndpoint}${suffix || ""}${quote}`
    );

    // Remove heavy obfuscated player scripts, then mount a controlled HLS fallback.
    out = out.replace(
      /<script[^>]+src=["'][^"']*(337ea903f50ac981414dfdddg0dssfsfsss459sc142984finalv3obv23|a3f0c6c86ccc3ece5dscs899e90s2)\.js[^"']*["'][^>]*>\s*<\/script>/gi,
      ""
    );

    const hlsLibUrl = buildProxyUrl("https://cdn.jsdelivr.net/npm/hls.js@latest", nextDepth, target.toString());
    const fallbackScript = `
<script>
(() => {
  const tokenEndpoint = ${JSON.stringify(proxiedTokenEndpoint)};
  const hlsLibUrl = ${JSON.stringify(hlsLibUrl)};
  let video = null;
  let hls = null;
  let tabsWrap = null;
  let currentPath = "";
  let currentTabIndex = 0;
  let lastStartAt = 0;

  const emitDiag = (event, data) => {
    try {
      if (typeof window.__embedProxyDiag === "function") {
        window.__embedProxyDiag(event, data || {});
        return;
      }
    } catch {}
    try {
      window.top?.postMessage({
        type: "__embed_proxy_diag",
        event,
        data: data || {},
        href: location.href,
        ts: Date.now(),
      }, "*");
    } catch {}
  };

  const randomNonce = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  };

  const toProxyWrap = (u) => {
    try {
      const abs = new URL(String(u || ""), location.href);
      return "/api/embed-proxy?url=" + encodeURIComponent(abs.toString()) + "&depth=0&ref=" + encodeURIComponent(location.href);
    } catch {
      return null;
    }
  };

  const ensureHls = async () => {
    if (window.Hls) return true;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = hlsLibUrl;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error("hls.js load failed"));
      document.head.appendChild(s);
    });
    return !!window.Hls;
  };

  const getTabsData = () => {
    const cfg = window.tabsConfig || {};
    const tabsRaw = Array.isArray(cfg.tabs) ? cfg.tabs : [];
    const cfgTabs = tabsRaw
      .map((tab, idx) => {
        const path = String((tab && (tab.mobile_path || tab.path)) || "").replace(/^\\/+/, "");
        if (!path) return null;
        const label =
          String((tab && (tab.title || tab.label || tab.name || tab.text)) || "").trim() ||
          "source " + (idx + 1);
        return { path, label };
      })
      .filter(Boolean);
    const domTabs = Array.from(
      document.querySelectorAll(".aplr-menu a[href], .servers_list a[href], [data-path], [data-mobile-path]")
    )
      .map((node, idx) => {
        try {
          const dataPath =
            String(node.getAttribute("data-mobile-path") || node.getAttribute("data-path") || "").trim();
          let path = dataPath.replace(/^\\/+/, "");
          if (!path) {
            const href = String(node.getAttribute("href") || "").trim();
            if (!href) return null;
            const u = new URL(href, location.href);
            path = String(u.pathname || "").replace(/^\\/+/, "");
          }
          if (!path || /^javascript:/i.test(path)) return null;
          const label = String(node.textContent || "").trim() || "source " + (idx + 1);
          return { path, label };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const tabMap = new Map();
    for (const tab of [...cfgTabs, ...domTabs]) {
      if (!tab || !tab.path || tabMap.has(tab.path)) continue;
      tabMap.set(tab.path, tab);
    }
    const tabs = Array.from(tabMap.values()).map((tab, idx) => ({
      idx,
      path: tab.path,
      label: tab.label || "source " + (idx + 1),
    }));
    const domains = Array.isArray(cfg.activeDomains)
      ? cfg.activeDomains.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (!domains.length) {
      try {
        const origin = String(location.origin || "").trim();
        if (origin) domains.push(origin);
      } catch {}
    }
    return { tabs, domains };
  };

  const mountHost = () => {
    return (
      document.querySelector(".player-container") ||
      document.querySelector(".video-con") ||
      document.querySelector(".aplr-player-content") ||
      document.body
    );
  };

  const ensureLayout = () => {
    const host = mountHost();
    if (!host) return false;

    if (!tabsWrap || !tabsWrap.isConnected) {
      tabsWrap = document.createElement("div");
      tabsWrap.id = "embed-proxy-yalla-tabs";
      tabsWrap.style.cssText =
        "display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 10px;background:#111;border:1px solid #1f2937;border-radius:10px;margin:8px;";
      host.prepend(tabsWrap);
    }

    video = document.getElementById("embed-proxy-yalla-video");
    if (!video) {
      video = document.createElement("video");
      video.id = "embed-proxy-yalla-video";
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.background = "#000";
      host.appendChild(video);
    }

    return true;
  };

  const markActiveTab = (idx) => {
    if (!tabsWrap) return;
    tabsWrap.querySelectorAll("button[data-idx]").forEach((node) => {
      const btn = node;
      const active = Number.parseInt(btn.dataset.idx || "-1", 10) === idx;
      btn.style.background = active ? "#0b3b7a" : "#1f2937";
      btn.style.color = active ? "#93c5fd" : "#d1d5db";
      btn.style.borderColor = active ? "#1d4ed8" : "#374151";
    });
  };

  const destroyHls = () => {
    if (!hls) return;
    try { hls.destroy(); } catch {}
    hls = null;
  };

  const requestToken = async (path) => {
    const form = new URLSearchParams();
    form.set("path", path);
    try {
      if (typeof window.__getCanvasFingerprint === "function") {
        const fp = window.__getCanvasFingerprint();
        if (fp) form.set("fp", fp);
      }
    } catch {}
    const tokenRes = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json, text/plain, */*",
      },
      body: form.toString(),
      credentials: "include",
      cache: "no-store",
    });
    if (!tokenRes.ok) return null;
    const tokenText = await tokenRes.text().catch(() => "");
    let tokenData = null;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {}
    if (!tokenData && tokenText) {
      const tokenMatch = tokenText.match(/["']token["']\s*:\s*["']([^"']+)["']/i);
      const sidMatch = tokenText.match(/["']session_id["']\s*:\s*["']([^"']+)["']/i);
      if (tokenMatch?.[1] && sidMatch?.[1]) {
        tokenData = { token: tokenMatch[1], session_id: sidMatch[1] };
      }
    }
    if (!tokenData || !tokenData.token || !tokenData.session_id) return null;
    return tokenData;
  };

  const buildCandidates = (path, tokenData, domains) => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomNonce();
    return domains.map((domain) => {
      const base = String(domain || "").replace(/\\/+$/, "");
      return (
        base +
        "/" +
        path +
        "?ts=" +
        ts +
        "&nonce=" +
        encodeURIComponent(nonce) +
        "&token=" +
        encodeURIComponent(tokenData.token) +
        "&sid=" +
        encodeURIComponent(tokenData.session_id)
      );
    });
  };

  const playStream = async (source) => {
    if (!video || !source) return false;
    emitDiag("yalla_play_source", { source });

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      destroyHls();
      video.src = source;
      await video.play().catch(() => {});
      return true;
    }

    const ok = await ensureHls().catch(() => false);
    if (!ok || !window.Hls || !window.Hls.isSupported()) {
      destroyHls();
      video.src = source;
      await video.play().catch(() => {});
      return true;
    }

    destroyHls();
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: 18,
      maxMaxBufferLength: 24,
      backBufferLength: 12,
      liveSyncDurationCount: 3,
    });
    window.__embedProxyYallaHls = hls;
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(source));
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_ev, data) => {
      emitDiag("yalla_hls_error", {
        type: data?.type || "",
        details: data?.details || "",
        fatal: !!data?.fatal,
      });
      if (!data?.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        try { hls.startLoad(); } catch {}
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch {}
        return;
      }
      emitDiag("yalla_fatal_stop", { path: currentPath, idx: currentTabIndex });
    });
    return true;
  };

  const playTab = async (tab, idx, force = false) => {
    if (!tab || !tab.path) return false;
    if (!force && Date.now() - lastStartAt < 500) return false;
    lastStartAt = Date.now();
    if (!ensureLayout()) return false;

    const { domains } = getTabsData();
    if (!domains.length) return false;

    const tokenData = await requestToken(tab.path);
    if (!tokenData) {
      emitDiag("yalla_token_fail", { path: tab.path });
      return false;
    }

    const candidates = buildCandidates(tab.path, tokenData, domains);
    currentPath = tab.path;
    currentTabIndex = idx;
    markActiveTab(idx);
    const sources = candidates.map((candidate) => toProxyWrap(candidate)).filter(Boolean);
    emitDiag("yalla_candidates", { path: tab.path, count: sources.length });

    if (!sources.length) {
      emitDiag("yalla_no_candidate", { path: tab.path, reason: "no_sources" });
      return false;
    }

    const firstOk = await playStream(sources[0]);
    if (firstOk) return true;

    for (let i = 1; i < sources.length; i++) {
      const ok = await playStream(sources[i]);
      if (ok) return true;
    }

    emitDiag("yalla_no_candidate", { path: tab.path });
    return false;
  };

  const buildTabsUi = (tabs) => {
    if (!tabsWrap) return;
    tabsWrap.innerHTML = "";
    tabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.idx = String(tab.idx);
      btn.textContent = tab.label;
      btn.style.cssText =
        "font-size:12px;font-weight:700;color:#d1d5db;background:#1f2937;border:1px solid #374151;border-radius:999px;padding:5px 10px;cursor:pointer;";
      btn.addEventListener("click", () => {
        playTab(tab, tab.idx, true).catch(() => {});
      });
      tabsWrap.appendChild(btn);
    });
  };

  let bootTries = 0;
  const boot = async () => {
    const { tabs } = getTabsData();
    if (!tabs.length) {
      bootTries += 1;
      if (bootTries < 30) setTimeout(() => { boot().catch(() => {}); }, 250);
      return;
    }
    if (!ensureLayout()) return;
    buildTabsUi(tabs);
    const first = tabs[0];
    await playTab(first, first.idx, true);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (video && video.currentSrc) video.play().catch(() => {});
    if (hls && typeof hls.startLoad === "function") {
      try { hls.startLoad(); } catch {}
    }
  });

  setTimeout(() => { boot().catch(() => {}); }, 80);
})();
</script>`;

    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${fallbackScript}</body>`);
    else out += fallbackScript;
  }

  if (host.endsWith("dishtrainer.net")) {
    const directCandidates = extractM3u8UrlsFromText(out);
    const packedCandidates = extractM3u8UrlsFromPackedEvalScripts(out);
    const candidates = Array.from(new Set([...directCandidates, ...packedCandidates]));
    const snippet = buildManualHlsFallbackSnippet({
      candidates,
      referrer: target.toString(),
      depth,
    });
    out = appendBeforeBody(out, snippet);
  }

  if (host.endsWith("koora-stream.top")) {
    const keepMainFrameScript = `
<script>
(() => {
  const isMainSrc = (value) => {
    const s = String(value || "").toLowerCase();
    return s.includes("dishtrainer.net/embed/") || s.includes("dishtrainer.net%2fembed%2f");
  };

  const shouldDropFrame = (value) => {
    const s = String(value || "").toLowerCase().trim();
    if (!s) return true;
    if (isMainSrc(s)) return false;
    if (s === "about:blank" || s === "javascript:false" || s.startsWith("javascript:")) return true;
    return (
      s.includes("dtscout.com") ||
      s.includes("crwdcntrl.net") ||
      s.includes("googletagmanager.com") ||
      s.includes("doubleclick.net")
    );
  };

    const tuneFrames = () => {
      const frames = Array.from(document.querySelectorAll("iframe"));
      let main = null;
      for (const f of frames) {
        const src = f.getAttribute("src") || "";
      if (isMainSrc(src)) {
        main = f;
        break;
      }
    }

    if (main) {
      const mainSrc = main.getAttribute("src") || "";
      if (mainSrc && !window.__embedProxyKooraRedirected) {
        try {
          window.__embedProxyKooraRedirected = true;
          location.replace(mainSrc);
          return;
        } catch {}
      }
    }

    for (const f of frames) {
      if (f === main) continue;
      const src = f.getAttribute("src") || "";
      if (shouldDropFrame(src)) {
        try { f.remove(); } catch {}
      }
    }

    if (main) {
      try {
        const st = main.style;
        st.position = "absolute";
        st.inset = "0";
        st.width = "100%";
        st.height = "100%";
        st.border = "0";

        const parent = main.parentElement;
        if (parent) {
          parent.style.position = "relative";
          parent.style.width = "100%";
          parent.style.height = "100%";
          parent.style.minHeight = "100%";
        }
      } catch {}
    }
  };

  setTimeout(tuneFrames, 60);
  setTimeout(tuneFrames, 350);
  setTimeout(tuneFrames, 1000);
  setInterval(tuneFrames, 1400);
})();
</script>`;

    out = appendBeforeBody(out, keepMainFrameScript);
  }

  if (host.endsWith("pyxq.online")) {
    const servValues: string[] = [];
    const servMatch = out.match(/var\s+servs\s*=\s*\[([^\]]+)\]/i);
    if (servMatch?.[1]) {
      const quoted = servMatch[1].matchAll(/["']([^"']+)["']/g);
      for (const m of quoted) {
        const v = String(m[1] || "").trim();
        if (v) servValues.push(v);
      }
    }

    const fallbackServs = ["cdn44", "cdn33", "cdn5"];
    const allServs = Array.from(new Set([...servValues, ...fallbackServs]));

    const pathMatch = out.match(/\.4job\.online\/live\/([a-z0-9_-]+)\/playlist\.m3u8/i);
    const streamPath = String(pathMatch?.[1] || "x3").trim();

    const candidates = allServs.map((serv) => `https://${serv}.4job.online/live/${streamPath}/playlist.m3u8`);
    const snippet = buildManualHlsFallbackSnippet({
      candidates,
      referrer: target.toString(),
      depth,
    });
    out = appendBeforeBody(out, snippet);
  }

  if (host.endsWith("yallashoot2026.net")) {
    let ch = "ch3";
    let iv = 1800000;
    const domains: string[] = ["yallashootttv.com", "yallaliveshoot.info"];

    const cfgMatch = out.match(
      /const\s+C\s*=\s*\{[\s\S]*?ch\s*:\s*['"]([^'"]+)['"][\s\S]*?dm\s*:\s*\[([^\]]+)\][\s\S]*?iv\s*:\s*(\d+)/i
    );

    if (cfgMatch?.[1]) ch = String(cfgMatch[1]).trim() || ch;
    if (cfgMatch?.[2]) {
      const parsed: string[] = [];
      const quoted = cfgMatch[2].matchAll(/["']([^"']+)["']/g);
      for (const m of quoted) {
        const v = String(m[1] || "").trim();
        if (v) parsed.push(v);
      }
      if (parsed.length) {
        domains.length = 0;
        domains.push(...parsed);
      }
    }
    if (cfgMatch?.[3]) {
      const parsedIv = Number.parseInt(String(cfgMatch[3]), 10);
      if (Number.isFinite(parsedIv) && parsedIv > 0) iv = parsedIv;
    }

    const toRollingPrefix = (ts: number, interval: number, len = 5) => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz";
      let value = Math.floor(ts / interval);
      let outPrefix = "";
      while (outPrefix.length < len) {
        outPrefix = alphabet[value % 26] + outPrefix;
        value = Math.floor(value / 26);
      }
      return outPrefix;
    };

    const prefix = toRollingPrefix(Date.now(), iv, 5);
    const candidates = domains.map((d) => `https://${prefix}.${d}/hls/${ch}/master.m3u8`);
    candidates.push(`https://cdzgq.yallaliveshoot.info/hls/${ch}/live/index.m3u8`);

    const snippet = buildManualHlsFallbackSnippet({
      candidates,
      referrer: target.toString(),
      depth,
    });
    out = appendBeforeBody(out, snippet);
  }

  // Common inline player configs that set direct media source in JS.
  out = out.replace(/source\s*:\s*u(\s*[,}])/g, "source:window.__embedProxyWrap(u)$1");

  out = out.replace(/source\s*:\s*(["']https?:\/\/[^"']+\.m3u8[^"']*["'])(\s*[,}])/gi, (_m, expr, tail) => {
    return `source:window.__embedProxyWrap(${expr})${tail}`;
  });

  out = out.replace(/source\s*:\s*((["']https:\/\/["']\s*\+\s*serv\s*\+\s*["']\.[^"']+\.m3u8["']))(\s*[,}])/gi, (_m, expr, _inner, tail) => {
    return `source:window.__embedProxyWrap(${expr})${tail}`;
  });

  out = out.replace(/loadSource\(([^)]+)\)/g, (_m, arg) => {
    return `loadSource(window.__embedProxyWrap(${arg}))`;
  });

  return out;
}

function parseDepth(value: string | null) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_PROXY_DEPTH, Math.max(0, parsed));
}

function sanitizeMalformedTargetUrl(rawValue: string, referrerUrl?: string | null) {
  let out = String(rawValue || "").trim();
  if (!out) return out;

  const lower = out.toLowerCase();
  const localMatch = lower.match(/https?:?\/\/localhost/);
  const localIndex = localMatch?.index ?? -1;
  if (localIndex > 0) {
    let prefix = out.slice(0, localIndex);
    while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);

    const localPart = out.slice(localIndex);
    const localLower = localPart.toLowerCase();
    const hostStart = localLower.indexOf("localhost");
    const slashAfterHost = localPart.indexOf("/", hostStart >= 0 ? hostStart + "localhost".length : 0);
    const tail = slashAfterHost >= 0 ? localPart.slice(slashAfterHost + 1) : "";
    if (prefix && tail) out = `${prefix}/${tail}`;
  }

  if (/^\//.test(out) && referrerUrl) {
    try {
      out = new URL(out, referrerUrl).toString();
    } catch {}
  }

  return out;
}

function parseSafeReferrer(value: string | null) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (isPrivateHost(u.hostname)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function buildUpstreamRequestHeaders(req: Request, target: URL, referrerUrl?: string | null) {
  const out = new Headers();
  const incoming = new Headers(req.headers);
  const fallbackReferrer = `${target.protocol}//${target.host}/`;
  const referer = referrerUrl || fallbackReferrer;
  let origin = `${target.protocol}//${target.host}`;
  try {
    origin = new URL(referer).origin;
  } catch {}

  out.set("user-agent", incoming.get("user-agent") || DEFAULT_USER_AGENT);
  out.set("accept", incoming.get("accept") || "*/*");
  out.set("accept-language", incoming.get("accept-language") || "ar,en-US;q=0.9,en;q=0.8");
  // Ask upstream for plain payloads to avoid encoding/header mismatches when re-streaming.
  out.set("accept-encoding", "identity");
  out.set("referer", referer);
  out.set("origin", origin);
  out.set("cache-control", "no-cache");
  out.set("pragma", "no-cache");

  const range = incoming.get("range");
  if (range) out.set("range", range);

  const contentType = incoming.get("content-type");
  if (contentType) out.set("content-type", contentType);

  const xRequestedWith = incoming.get("x-requested-with");
  if (xRequestedWith) out.set("x-requested-with", xRequestedWith);

  const cookie = incoming.get("cookie");
  if (cookie) out.set("cookie", cookie);

  return out;
}

function filterResponseHeaders(source: Headers, { html }: { html: boolean }) {
  const out = new Headers();

  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-length" || lower === "content-encoding") return;

    if (lower === "set-cookie") {
      out.append(key, value);
      return;
    }

    if (html) {
      if (
        lower === "x-frame-options" ||
        lower === "frame-options" ||
        lower === "content-security-policy" ||
        lower === "content-security-policy-report-only"
      ) {
        return;
      }
    }

    out.set(key, value);
  });

  out.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  out.set("Pragma", "no-cache");
  out.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return out;
}

async function handleProxyRequest(req: Request) {
  try {
    const startedAt = Date.now();
    const requestUrl = new URL(req.url);
    const rawUrl = requestUrl.searchParams.get("url");
    const depth = parseDepth(requestUrl.searchParams.get("depth"));
    const safeReferrer = parseSafeReferrer(requestUrl.searchParams.get("ref"));
    const stableMode = requestUrl.searchParams.get("stable") === "1";

    if (!rawUrl) {
      return NextResponse.json({ error: "Missing query parameter: url" }, { status: 400 });
    }

    let target: URL;
    const normalizedRawUrl = sanitizeMalformedTargetUrl(rawUrl, safeReferrer);
    try {
      target = new URL(normalizedRawUrl);
    } catch {
      if (!safeReferrer) {
        return NextResponse.json({ error: "Invalid target url" }, { status: 400 });
      }
      try {
        target = new URL(normalizedRawUrl, safeReferrer);
      } catch {
        return NextResponse.json({ error: "Invalid target url" }, { status: 400 });
      }
    }

    if (!/^https?:$/i.test(target.protocol)) {
      return NextResponse.json({ error: "Only http/https targets are allowed" }, { status: 400 });
    }

    if (isPrivateHost(target.hostname)) {
      return NextResponse.json({ error: "Target host is not allowed" }, { status: 403 });
    }

    if (ALLOWED_HOST_SUFFIXES.length && !hostMatchesAny(target.hostname, ALLOWED_HOST_SUFFIXES)) {
      return NextResponse.json(
        {
          error:
            "Target host is outside EMBED_PROXY_ALLOWED_HOSTS. Set EMBED_PROXY_ALLOWED_HOSTS to include this domain.",
        },
        { status: 403 }
      );
    }

    if (isBlockedAbsoluteUrl(target.toString())) {
      return new NextResponse(null, { status: 204 });
    }

    const withProxyMetaHeaders = (headers: Headers) => {
      headers.set("x-embed-proxy-target", target.toString());
      headers.set("x-embed-proxy-depth", String(depth));
      headers.set("x-embed-proxy-elapsed-ms", String(Date.now() - startedAt));
      return headers;
    };

    const method = String(req.method || "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await req.arrayBuffer() : undefined;
    const manifestCacheKey =
      method === "GET" && M3U8_CACHE_TTL_MS > 0 && shouldUseManifestCacheForTarget(target)
        ? buildManifestCacheKey(target, depth, safeReferrer)
        : null;

    if (manifestCacheKey) {
      const now = Date.now();
      const cached = manifestCache.get(manifestCacheKey);
      if (cached && cached.expiresAt > now) {
        const headers = withProxyMetaHeaders(new Headers(cached.headers));
        headers.set("x-embed-proxy-cache", "hit");
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        });
      }
      trimManifestCache(now);
    }

    const upstream = await fetch(target.toString(), {
      method,
      headers: buildUpstreamRequestHeaders(req, target, safeReferrer),
      redirect: "follow",
      cache: "no-store",
      body,
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    const isCss = contentType.includes("text/css");

    if (method === "HEAD") {
      const headers = withProxyMetaHeaders(filterResponseHeaders(upstream.headers, { html: false }));
      headers.set("x-embed-proxy-cache", "bypass");
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    if (!isHtml) {
      if (isLikelyM3u8(target, contentType)) {
        const rawManifest = await upstream.text();
        const rewrittenManifest = rewriteM3u8Manifest(
          rawManifest,
          target.toString(),
          depth,
          safeReferrer || target.toString()
        );
        const headers = withProxyMetaHeaders(filterResponseHeaders(upstream.headers, { html: false }));
        headers.set("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
        headers.set("x-embed-proxy-cache", manifestCacheKey ? "miss" : "bypass");

        if (manifestCacheKey && upstream.ok) {
          manifestCache.set(manifestCacheKey, {
            body: rewrittenManifest,
            expiresAt: Date.now() + M3U8_CACHE_TTL_MS,
            headers: Array.from(headers.entries()),
            status: upstream.status,
            statusText: upstream.statusText,
          });
          trimManifestCache();
        }

        return new Response(rewrittenManifest, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      }

      if (isCss) {
        const rawCss = await upstream.text();
        const rewrittenCss = rewriteCssUrls(rawCss, target.toString(), depth);
        const headers = withProxyMetaHeaders(filterResponseHeaders(upstream.headers, { html: false }));
        headers.set("content-type", "text/css; charset=utf-8");
        return new Response(rewrittenCss, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      }

      const headers = withProxyMetaHeaders(filterResponseHeaders(upstream.headers, { html: false }));
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    let html = await upstream.text();
    html = rewriteAttributeUrls(html, target.toString(), depth);
    html = rewriteSrcsetUrls(html, target.toString(), depth);
    html = rewriteKnownInlineEndpoints(html, target, depth);
    html = bypassHostLockChecks(html, target);
    html = injectProtection(html, buildInjection(depth, target.toString(), stableMode));

    const headers = withProxyMetaHeaders(filterResponseHeaders(upstream.headers, { html: true }));
    headers.set("content-type", "text/html; charset=utf-8");

    return new Response(html, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handleProxyRequest(req);
}

export async function POST(req: Request) {
  return handleProxyRequest(req);
}

export async function HEAD(req: Request) {
  return handleProxyRequest(req);
}
