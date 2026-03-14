const { chromium } = require("playwright");

const channelUrl = String(process.argv[2] || "").trim();
const BROWSER_TIMEOUT_MS = 20000;

function normalizeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
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
      if (!trimmed.startsWith("#EXT-X-STREAM-INF")) previousExtInf = false;
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

async function main() {
  if (!channelUrl) {
    console.log(JSON.stringify({ ok: false, error: "missing-channel-url" }));
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
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

  const page = await context.newPage();
  let lastManifestUrl = "";
  let lastManifestRequestHeaders = {};
  let manifestResolved = false;
  const pendingTasks = new Set();

  const emitAndExit = async (payload) => {
    if (manifestResolved) return;
    manifestResolved = true;
    console.log(JSON.stringify(payload));
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(0);
  };

  page.on("request", (request) => {
    const url = normalizeHttpUrl(request.url());
    if (!url || !looksLikeManifestUrl(url)) return;
    lastManifestRequestHeaders = request.headers();
  });

  page.on("console", (message) => {
    const text = String(message.text() || "");
    const match = text.match(/loadSource:(https?:\/\/\S+)/i);
    const candidate = normalizeHttpUrl(match && match[1] ? match[1] : "");
    if (candidate && looksLikeManifestUrl(candidate)) {
      lastManifestUrl = candidate;
    }
  });

  page.on("response", (response) => {
    const task = (async () => {
      if (manifestResolved) return;
      const url = normalizeHttpUrl(response.url());
      const contentType = String(response.headers()["content-type"] || "").toLowerCase();
      if (!url || (!looksLikeManifestUrl(url) && !contentType.includes("mpegurl"))) return;
      lastManifestUrl = url;
      try {
        const body = await response.text().catch(() => "");
        if (!body.trim() || !/^\s*#extm3u/m.test(body) || !hasMediaSegments(body, url)) return;
        await emitAndExit({
          ok: true,
          manifestUrl: url,
          manifestBody: body,
          referrerUrl: normalizeHttpUrl(page.url()) || channelUrl,
          manifestRequestHeaders: lastManifestRequestHeaders,
          playbackUrl: channelUrl,
        });
      } catch {}
    })();
    pendingTasks.add(task);
    task.finally(() => {
      pendingTasks.delete(task);
    });
  });

  let timeoutResult = null;
  try {
    await page.goto(channelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(BROWSER_TIMEOUT_MS);
    if (!manifestResolved && pendingTasks.size) {
      await Promise.allSettled(Array.from(pendingTasks));
    }
  } catch (error) {
    timeoutResult = {
      ok: false,
      error: error instanceof Error ? error.message : String(error || "goto-failed"),
      manifestUrl: lastManifestUrl,
      manifestBody: "",
      referrerUrl: normalizeHttpUrl(page.url()) || channelUrl,
      manifestRequestHeaders: lastManifestRequestHeaders,
      playbackUrl: channelUrl,
    };
  }

  if (!timeoutResult) {
    timeoutResult = {
      ok: false,
      manifestUrl: lastManifestUrl,
      manifestBody: "",
      referrerUrl: normalizeHttpUrl(page.url()) || channelUrl,
      manifestRequestHeaders: lastManifestRequestHeaders,
      playbackUrl: channelUrl,
    };
  }

  console.log(JSON.stringify(timeoutResult));
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
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
      playbackUrl: channelUrl,
    })
  );
});
