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
  return hostMatchesAny(host, STREAM_HOST_DIRECT_FROM_ENV);
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
        const keepDirect = isAllowedStreamHost(host) || shouldKeepDirectHost(host);
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
          if (!(isAllowedStreamHost(host) || shouldKeepDirectHost(host)) && depth < MAX_PROXY_DEPTH) {
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

function buildInjection(depth: number, currentTargetUrl: string, stableMode: boolean) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const blockedHosts = JSON.stringify(BLOCKED_HOST_SUFFIXES);
  const blockedWords = JSON.stringify(BLOCKED_KEYWORDS);
  const allowedHosts = JSON.stringify([...STREAM_HOST_ALLOW_SUFFIXES, ...STREAM_HOST_ALLOWLIST_FROM_ENV]);
  const directHosts = JSON.stringify(STREAM_HOST_DIRECT_FROM_ENV);
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

  const hostAllowed = (host) => {
    const h = String(host || "").toLowerCase();
    return allowedHosts.some((suffix) => h === suffix || h.endsWith("." + suffix));
  };
  
  const hostDirect = (host) => {
    const h = String(host || "").toLowerCase();
    return (
      hostAllowed(h) ||
      directHosts.some((suffix) => h === suffix || h.endsWith("." + suffix))
    );
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
      const abs = new URL(raw, currentTargetUrl);
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
    try {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        try {
          const method =
            String(
              init?.method ||
                (input instanceof Request ? input.method : "GET")
            ).toUpperCase();
          if (method === "GET") {
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
          }
        } catch {}
        return nativeFetch(input, init);
      };
    } catch {}

    try {
      const nativeOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (...args) {
        try {
          if (args.length >= 2 && typeof args[1] === "string") {
            const rewritten = toProxy(args[1]);
            if (rewritten && rewritten !== args[1]) args[1] = rewritten;
          }
        } catch {}
        return nativeOpen.apply(this, args);
      };
    } catch {}
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
        location.replace(u.toString());
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

  const start = () => {
    lockPopupApis();
    interceptNetworkApis();
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
  } else {
    start();
  }
})();
</script>
`;
}

function injectProtection(html: string, snippet: string) {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${snippet}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${snippet}`);
  return `${snippet}${html}`;
}

function parseDepth(value: string | null) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_PROXY_DEPTH, Math.max(0, parsed));
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

  return out;
}

function filterResponseHeaders(source: Headers, { html }: { html: boolean }) {
  const out = new Headers();

  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "set-cookie") return;
    if (lower === "content-length" || lower === "content-encoding") return;

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

export async function GET(req: Request) {
  try {
    const requestUrl = new URL(req.url);
    const rawUrl = requestUrl.searchParams.get("url");
    const depth = parseDepth(requestUrl.searchParams.get("depth"));
    const safeReferrer = parseSafeReferrer(requestUrl.searchParams.get("ref"));
    const stableMode = requestUrl.searchParams.get("stable") === "1";

    if (!rawUrl) {
      return NextResponse.json({ error: "Missing query parameter: url" }, { status: 400 });
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: "Invalid target url" }, { status: 400 });
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

    const upstream = await fetch(target.toString(), {
      method: "GET",
      headers: buildUpstreamRequestHeaders(req, target, safeReferrer),
      redirect: "follow",
      cache: "no-store",
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

    if (!isHtml) {
      const headers = filterResponseHeaders(upstream.headers, { html: false });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    let html = await upstream.text();
    html = rewriteAttributeUrls(html, target.toString(), depth);
    html = rewriteSrcsetUrls(html, target.toString(), depth);
    html = injectProtection(html, buildInjection(depth, target.toString(), stableMode));

    const headers = filterResponseHeaders(upstream.headers, { html: true });
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
