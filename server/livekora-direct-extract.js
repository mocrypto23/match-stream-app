const axios = require("axios");
const { chromium } = require("playwright");

const sourceUrl = String(process.argv[2] || "").trim();
const playbackUrlArg = String(process.argv[3] || "").trim();
const PAGE_GOTO_TIMEOUT_MS = 12000;
const PAGE_SETTLE_TIMEOUT_MS = 3500;
const PAGE_NETWORK_IDLE_TIMEOUT_MS = 3000;
const OVERALL_TIMEOUT_MS = 24000;
const MAX_PAGE_VISITS = 8;
const PLAYER_OPTION_WAIT_MS = 1400;
const SUCCESS_COLLECTION_WINDOW_MS = 6000;
const LIVEKORA_HOST_SUFFIXES = [
  "sportsurges.cc",
  "sportsurges.online",
  "livekora.vip",
  "koooralive.click",
  "kooraxx.com",
];

function normalizeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function hostMatchesAnySuffix(hostname, suffixes) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function hasMediaSegments(manifestText, baseUrl) {
  let previousExtInf = false;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      previousExtInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      if (absolute && previousExtInf) return true;
    } catch {}
    previousExtInf = false;
  }
  return false;
}

function looksLikeManifestUrl(rawUrl) {
  const url = normalizeHttpUrl(rawUrl);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = String(parsed.pathname || "").toLowerCase();
    const search = String(parsed.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (/\.(?:ts|m4s|mp4|aac|mp3|vtt)(?:$|[?#])/i.test(pathname)) return false;
    if (combined.includes(".m3u8")) return true;
    return (
      pathname.includes("/hls/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      search.includes("playlist") ||
      search.includes("m3u8")
    );
  } catch {
    return false;
  }
}

function looksLikeSegmentUrl(rawUrl) {
  const url = normalizeHttpUrl(rawUrl);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = String(parsed.pathname || "").toLowerCase();
    return /\.(?:ts|m4s|aac|mp3|mp4)(?:$|[?#])/i.test(pathname);
  } catch {
    return false;
  }
}

function streamKeyFromUrl(rawUrl) {
  const url = normalizeHttpUrl(rawUrl);
  if (!url) return "";
  try {
    const pathname = String(new URL(url).pathname || "");
    const filename = pathname.split("/").filter(Boolean).at(-1) || "";
    const base = filename.replace(/\.(?:m3u8|ts|m4s|aac|mp3|mp4)$/i, "");
    const match = base.match(/^([a-z0-9]+?)(?:-\d+)?$/i);
    return String(match && match[1] ? match[1] : base).trim().toLowerCase();
  } catch {
    return "";
  }
}

function pickVariantManifestUrl(manifestText, baseUrl) {
  let pendingBandwidth = -1;
  const variants = [];
  let order = 0;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match && match[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      if (!absolute || !absolute.toLowerCase().includes(".m3u8")) {
        pendingBandwidth = -1;
        continue;
      }
      variants.push({
        url: absolute,
        bandwidth: Number.isFinite(pendingBandwidth) ? pendingBandwidth : -1,
        order,
      });
      order += 1;
      pendingBandwidth = -1;
    } catch {
      pendingBandwidth = -1;
    }
  }
  variants.sort((left, right) => {
    if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth;
    return left.order - right.order;
  });
  return variants[0] ? variants[0].url : "";
}

function buildUpstreamFetchHeaders(requestHeaders, referrerUrl, accept) {
  const headers = {
    accept,
    "user-agent":
      String(requestHeaders && requestHeaders["user-agent"] ? requestHeaders["user-agent"] : "").trim() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  };
  const referer =
    String(
      (requestHeaders && (requestHeaders.referer || requestHeaders.referrer)) || referrerUrl || playbackUrlArg || sourceUrl
    ).trim() || "";
  if (referer) headers.referer = referer;
  try {
    const origin = String((requestHeaders && requestHeaders.origin) || (referer ? new URL(referer).origin : "")).trim();
    if (origin) headers.origin = origin;
  } catch {}
  for (const key of [
    "accept-language",
    "cookie",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
  ]) {
    const value = String(requestHeaders && requestHeaders[key] ? requestHeaders[key] : "").trim();
    if (value) headers[key] = value;
  }
  return headers;
}

async function fetchManifestWithHeaders(manifestUrl, requestHeaders, referrerUrl) {
  const normalizedManifestUrl = normalizeHttpUrl(manifestUrl);
  if (!normalizedManifestUrl) return { finalUrl: "", manifestBody: "", error: "invalid-manifest-url", snippet: "" };
  const headers = buildUpstreamFetchHeaders(
    requestHeaders,
    referrerUrl,
    "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*"
  );

  const fetchText = async (targetUrl) => {
    try {
      const response = await axios.get(targetUrl, {
        responseType: "text",
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers,
      });
      if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) {
        return { body: "", error: `http-${Number(response.status || 0)}`, snippet: String(response.data || "").slice(0, 160) };
      }
      const body = String(response.data || "");
      return { body: body.trim() ? body : "", error: body.trim() ? "" : "empty-body", snippet: body.slice(0, 160) };
    } catch (error) {
      return {
        body: "",
        error: error instanceof Error ? error.message : String(error || "axios-fetch-failed"),
        snippet: "",
      };
    }
  };

  const primary = await fetchText(normalizedManifestUrl);
  let body = primary.body;
  if (!body || !/^\s*#extm3u/im.test(body)) {
    return {
      finalUrl: normalizedManifestUrl,
      manifestBody: "",
      error: primary.error || "not-manifest",
      snippet: primary.snippet || "",
    };
  }
  if (hasMediaSegments(body, normalizedManifestUrl)) {
    return {
      finalUrl: normalizedManifestUrl,
      manifestBody: body,
      error: "",
      snippet: body.slice(0, 160),
    };
  }

  const variantUrl = pickVariantManifestUrl(body, normalizedManifestUrl);
  if (!variantUrl) {
    return {
      finalUrl: normalizedManifestUrl,
      manifestBody: body,
      error: "",
      snippet: body.slice(0, 160),
    };
  }
  const variant = await fetchText(variantUrl);
  const variantBody = variant.body;
  if (!variantBody || !/^\s*#extm3u/im.test(variantBody)) {
    return {
      finalUrl: variantUrl,
      manifestBody: "",
      error: variant.error || "variant-not-manifest",
      snippet: variant.snippet || "",
    };
  }
  return {
    finalUrl: variantUrl,
    manifestBody: variantBody,
    error: "",
    snippet: variantBody.slice(0, 160),
  };
}

function buildPlaybackCandidates(rawSourceUrl, rawPlaybackUrl) {
  const ordered = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = normalizeHttpUrl(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  const seedUrls = [rawPlaybackUrl, rawSourceUrl].map((item) => normalizeHttpUrl(item)).filter(Boolean);
  for (const seedUrl of seedUrls) {
    push(seedUrl);
    try {
      const parsed = new URL(seedUrl);
      const host = String(parsed.hostname || "").toLowerCase();
      const pathParts = String(parsed.pathname || "")
        .split("/")
        .map((part) => String(part || "").trim())
        .filter(Boolean);
      const slug = String(pathParts[0] === "albaplayer" ? pathParts[1] || "" : pathParts[0] || "").trim().toLowerCase();
      if (!slug) continue;

      const scheme = parsed.protocol === "http:" ? "http" : "https";
      const hostParts = host.split(".").filter(Boolean);
      const firstLabel = hostParts.length > 2 ? hostParts[0] || "" : "";
      const originVariants = new Set([parsed.origin]);
      for (const familyHost of LIVEKORA_HOST_SUFFIXES) {
        originVariants.add(`${scheme}://${familyHost}`);
        if (familyHost.startsWith("sportsurges.") && firstLabel && /^\d+$/.test(firstLabel)) {
          originVariants.add(`${scheme}://${firstLabel}.${familyHost}`);
        }
      }

      for (const origin of originVariants) {
        push(`${origin}/${slug}/`);
      }
      for (const origin of originVariants) {
        push(`${origin}/albaplayer/${slug}/`);
        for (const serv of ["2", "5", "1", "0", "3", "4"]) {
          push(`${origin}/albaplayer/${slug}/?serv=${serv}`);
        }
      }
    } catch {}
  }

  return ordered;
}

function pickLikelyPageLinks(rawUrls, currentUrl) {
  const current = normalizeHttpUrl(currentUrl);
  const currentHost = current ? new URL(current).hostname.toLowerCase() : "";
  const out = [];
  const seen = new Set();

  for (const rawValue of rawUrls || []) {
    const normalized = normalizeHttpUrl(rawValue);
    if (!normalized || seen.has(normalized) || looksLikeManifestUrl(normalized)) continue;
    seen.add(normalized);
    try {
      const parsed = new URL(normalized);
      const pathname = String(parsed.pathname || "").toLowerCase();
      const host = parsed.hostname.toLowerCase();
      const sameFamily =
        host === currentHost ||
        hostMatchesAnySuffix(host, LIVEKORA_HOST_SUFFIXES) ||
        pathname.includes("/albaplayer/") ||
        pathname.includes("/alba.php");
      if (!sameFamily) continue;
      out.push(normalized);
    } catch {}
  }

  return out;
}

async function collectLinkedUrls(page, currentUrl) {
  const rawUrls = await page
    .evaluate(() => {
      const values = new Set();
      const push = (value) => {
        const normalized = String(value || "").trim();
        if (normalized) values.add(normalized);
      };
      for (const selector of ["iframe", "a", "link", "source", "video"]) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          push(element.getAttribute("src"));
          push(element.getAttribute("data-src"));
          push(element.getAttribute("href"));
        }
      }
      const html = document.documentElement?.outerHTML || "";
      for (const match of html.matchAll(/https?:\/\/[^"'\\s<>]+/gi)) {
        push(match[0]);
      }
      return Array.from(values);
    })
    .catch(() => []);

  const resolved = [];
  for (const rawValue of rawUrls) {
    try {
      resolved.push(new URL(String(rawValue || "").trim(), currentUrl).toString());
    } catch {}
  }
  return pickLikelyPageLinks(resolved, currentUrl);
}

async function clickLikelyPlayTarget(page) {
  for (const selector of [
    "button[aria-label*='Play' i]",
    "button[title*='Play' i]",
    ".plyr__control--overlaid",
    ".vjs-big-play-button",
    "[data-testid*='play' i]",
    ".jw-icon-display",
  ]) {
    const handle = await page.$(selector).catch(() => null);
    if (!handle) continue;
    await handle.click({ force: true }).catch(() => null);
    return true;
  }
  return false;
}

async function clickPlayerOptionButtons(page, budgetMs) {
  const startedAt = Date.now();
  const clicked = new Set();
  while (Date.now() - startedAt < budgetMs) {
    const buttons = await page
      .locator("button")
      .evaluateAll((elements) =>
        elements
          .map((element, index) => ({
            index,
            text: String(element.textContent || "").trim(),
          }))
          .filter((item) => /(?:مشغل|player|sd|hd)/i.test(item.text))
      )
      .catch(() => []);
    if (!buttons.length) return;
    let clickedAny = false;
    for (const button of buttons) {
      const text = String(button.text || "").trim();
      if (!text || clicked.has(text)) continue;
      clicked.add(text);
      clickedAny = true;
      await page.getByRole("button", { name: text, exact: true }).click({ force: true }).catch(() => null);
      await page.waitForTimeout(PLAYER_OPTION_WAIT_MS).catch(() => {});
    }
    if (!clickedAny) return;
  }
}

async function main() {
  if (!sourceUrl) {
    console.log(JSON.stringify({ ok: false, error: "missing-channel-url" }));
    return;
  }

  const playbackCandidates = buildPlaybackCandidates(sourceUrl, playbackUrlArg);
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "ar-EG",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      "accept-language": "ar,en-US;q=0.9,en;q=0.8",
    },
  });

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
    } catch {}
  });

  const page = await context.newPage();
  let lastManifestUrl = "";
  let lastManifestBody = "";
  let lastManifestRequestHeaders = {};
  let lastReferrerUrl = normalizeHttpUrl(playbackCandidates[0] || sourceUrl) || sourceUrl;
  let lastPlaybackUrl = lastReferrerUrl;
  let lastError = "";
  let successCollectionDeadlineAt = 0;
  const pendingTasks = new Set();
  const deadlineAt = Date.now() + OVERALL_TIMEOUT_MS;
  const queuedUrls = [...playbackCandidates];
  const visitedUrls = new Set();
  const manifestCandidates = new Map();

  const registerManifestCandidate = ({ manifestUrl, requestHeaders, referrerUrl, playbackUrl, manifestBody }) => {
    const normalizedManifestUrl = normalizeHttpUrl(manifestUrl);
    if (!normalizedManifestUrl || !looksLikeManifestUrl(normalizedManifestUrl)) return null;
    const key = normalizedManifestUrl.toLowerCase();
    const existing = manifestCandidates.get(key);
    const candidate = {
      manifestUrl: normalizedManifestUrl,
      manifestBody: String(manifestBody || existing?.manifestBody || "").trim(),
      manifestRequestHeaders:
        requestHeaders && typeof requestHeaders === "object"
          ? requestHeaders
          : existing?.manifestRequestHeaders || {},
      referrerUrl: normalizeHttpUrl(referrerUrl || existing?.referrerUrl || lastReferrerUrl || sourceUrl) || sourceUrl,
      playbackUrl: normalizeHttpUrl(playbackUrl || existing?.playbackUrl || lastPlaybackUrl || sourceUrl) || sourceUrl,
      discoveredAt: existing?.discoveredAt || Date.now(),
      segmentHits: Number(existing?.segmentHits || 0),
      streamKey: streamKeyFromUrl(normalizedManifestUrl),
    };
    manifestCandidates.set(key, candidate);
    lastManifestUrl = candidate.manifestUrl;
    lastManifestRequestHeaders = candidate.manifestRequestHeaders;
    lastReferrerUrl = candidate.referrerUrl;
    lastPlaybackUrl = candidate.playbackUrl;
    if (candidate.manifestBody) {
      lastManifestBody = candidate.manifestBody;
      successCollectionDeadlineAt ||= Math.min(deadlineAt, Date.now() + SUCCESS_COLLECTION_WINDOW_MS);
    }
    return candidate;
  };

  const noteSegmentTraffic = (rawUrl) => {
    const normalizedUrl = normalizeHttpUrl(rawUrl);
    if (!normalizedUrl || !looksLikeSegmentUrl(normalizedUrl)) return;
    const segmentKey = streamKeyFromUrl(normalizedUrl);
    if (!segmentKey) return;
    for (const candidate of manifestCandidates.values()) {
      if (!candidate.streamKey || candidate.streamKey !== segmentKey) continue;
      candidate.segmentHits += 1;
      successCollectionDeadlineAt ||= Math.min(deadlineAt, Date.now() + SUCCESS_COLLECTION_WINDOW_MS);
    }
  };

  const updateManifestCandidate = ({ manifestUrl, requestHeaders, referrerUrl }) => {
    registerManifestCandidate({
      manifestUrl,
      requestHeaders,
      referrerUrl,
      playbackUrl: lastPlaybackUrl || sourceUrl,
    });
  };

  page.on("request", (request) => {
    const url = normalizeHttpUrl(request.url());
    const headers = request.headers();
    const accept = String(headers.accept || "").toLowerCase();
    if (looksLikeSegmentUrl(url)) {
      noteSegmentTraffic(url);
      return;
    }
    if (!url || (!looksLikeManifestUrl(url) && !accept.includes("mpegurl") && !accept.includes("x-mpegurl"))) return;
    updateManifestCandidate({
      manifestUrl: url,
      requestHeaders: headers,
      referrerUrl: normalizeHttpUrl(page.url()) || lastReferrerUrl || sourceUrl,
    });
  });

  page.on("console", (message) => {
    const text = String(message.text() || "");
    const match = text.match(/loadSource:(https?:\/\/\S+)/i);
    const candidate = normalizeHttpUrl(match && match[1] ? match[1] : "");
    updateManifestCandidate({
      manifestUrl: candidate,
      referrerUrl: normalizeHttpUrl(page.url()) || lastReferrerUrl || sourceUrl,
    });
  });

  page.on("response", (response) => {
    const task = (async () => {
      const url = normalizeHttpUrl(response.url());
      const contentType = String(response.headers()["content-type"] || "").toLowerCase();
      if (looksLikeSegmentUrl(url)) {
        noteSegmentTraffic(url);
        return;
      }
      if (!url || (!looksLikeManifestUrl(url) && !contentType.includes("mpegurl"))) return;
      const candidate = registerManifestCandidate({
        manifestUrl: url,
        requestHeaders: response.request().headers(),
        referrerUrl: normalizeHttpUrl(page.url()) || lastReferrerUrl || sourceUrl,
        playbackUrl: lastPlaybackUrl || sourceUrl,
      });
      try {
        const body = await response.text().catch(() => "");
        if (!body.trim() || !/^\s*#extm3u/im.test(body) || !hasMediaSegments(body, url)) return;
        if (!candidate) return;
        candidate.manifestBody = body;
        lastManifestBody = body;
        successCollectionDeadlineAt ||= Math.min(deadlineAt, Date.now() + SUCCESS_COLLECTION_WINDOW_MS);
      } catch {}
    })();
    pendingTasks.add(task);
    task.finally(() => {
      pendingTasks.delete(task);
    });
  });

  const chooseBestCandidate = async () => {
    const candidates = Array.from(manifestCandidates.values())
      .map((candidate) => ({ ...candidate }))
      .sort((left, right) => {
        if (right.segmentHits !== left.segmentHits) return right.segmentHits - left.segmentHits;
        if (!!right.manifestBody !== !!left.manifestBody) return right.manifestBody ? 1 : -1;
        return right.discoveredAt - left.discoveredAt;
      });

    let finalCandidate = candidates[0] || null;
    let helperFetchError = "";
    let helperFetchSnippet = "";
    if (finalCandidate && !finalCandidate.manifestBody) {
      try {
        const fetchedManifest = await fetchManifestWithHeaders(
          finalCandidate.manifestUrl,
          finalCandidate.manifestRequestHeaders,
          finalCandidate.referrerUrl || finalCandidate.playbackUrl || sourceUrl
        );
        helperFetchError = String((fetchedManifest && fetchedManifest.error) || "").trim();
        helperFetchSnippet = String((fetchedManifest && fetchedManifest.snippet) || "").slice(0, 160);
        if (fetchedManifest && fetchedManifest.finalUrl && fetchedManifest.manifestBody) {
          finalCandidate = {
            ...finalCandidate,
            manifestUrl: fetchedManifest.finalUrl,
            manifestBody: fetchedManifest.manifestBody,
          };
        }
      } catch (error) {
        helperFetchError = error instanceof Error ? error.message : String(error || "helper-fetch-failed");
      }
    }

    return {
      ok: !!(finalCandidate && finalCandidate.manifestUrl),
      error: lastError,
      manifestUrl: finalCandidate?.manifestUrl || lastManifestUrl,
      manifestBody: finalCandidate?.manifestBody || lastManifestBody,
      referrerUrl: finalCandidate?.referrerUrl || lastReferrerUrl || normalizeHttpUrl(page.url()) || sourceUrl,
      manifestRequestHeaders: finalCandidate?.manifestRequestHeaders || lastManifestRequestHeaders,
      playbackUrl: finalCandidate?.playbackUrl || lastPlaybackUrl || sourceUrl,
      helperFetchError,
      helperFetchSnippet,
      segmentHits: finalCandidate?.segmentHits || 0,
    };
  };

  try {
    while (queuedUrls.length && visitedUrls.size < MAX_PAGE_VISITS && Date.now() < deadlineAt) {
      if (successCollectionDeadlineAt && Date.now() >= successCollectionDeadlineAt) break;
      const currentUrl = normalizeHttpUrl(queuedUrls.shift());
      if (!currentUrl || visitedUrls.has(currentUrl)) continue;
      visitedUrls.add(currentUrl);
      lastPlaybackUrl = currentUrl;
      lastReferrerUrl = currentUrl;

      try {
        const gotoBudgetMs = Math.max(2_500, Math.min(PAGE_GOTO_TIMEOUT_MS, deadlineAt - Date.now()));
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: gotoBudgetMs,
        });
        lastReferrerUrl = normalizeHttpUrl(page.url()) || currentUrl;
        await page.waitForLoadState("networkidle", {
          timeout: Math.max(800, Math.min(PAGE_NETWORK_IDLE_TIMEOUT_MS, deadlineAt - Date.now())),
        }).catch(() => {});

        await clickLikelyPlayTarget(page).catch(() => false);
        await clickPlayerOptionButtons(page, Math.max(0, Math.min(6000, deadlineAt - Date.now()))).catch(() => {});
        if (Date.now() < deadlineAt) {
          await page.waitForTimeout(Math.max(500, Math.min(PAGE_SETTLE_TIMEOUT_MS, deadlineAt - Date.now())));
        }

        for (const linkedUrl of await collectLinkedUrls(page, page.url() || currentUrl)) {
          if (!visitedUrls.has(linkedUrl)) queuedUrls.push(linkedUrl);
        }

        if (pendingTasks.size) {
          await Promise.race([
            Promise.allSettled(Array.from(pendingTasks)),
            page.waitForTimeout(Math.max(250, Math.min(1200, deadlineAt - Date.now()))),
          ]).catch(() => {});
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error || "goto-failed");
      }
    }
  } finally {
    const payload = await chooseBestCandidate();
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log(JSON.stringify(payload));
  }
}

main().catch(async (error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error || "livekora-direct-failed"),
      manifestUrl: "",
      manifestBody: "",
      referrerUrl: "",
      manifestRequestHeaders: {},
      playbackUrl: normalizeHttpUrl(playbackUrlArg) || normalizeHttpUrl(sourceUrl) || sourceUrl,
    })
  );
});
