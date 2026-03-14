const { chromium } = require("playwright");

const channelUrl = String(process.argv[2] || "").trim();
const BROWSER_TIMEOUT_MS = 12000;

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
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  let finished = false;
  let lastManifestUrl = "";

  const finish = async (payload) => {
    if (finished) return;
    finished = true;
    console.log(JSON.stringify(payload));
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  };

  page.on("console", (message) => {
    const text = String(message.text() || "");
    const match = text.match(/loadSource:(https?:\/\/\S+)/i);
    const candidate = normalizeHttpUrl(match && match[1] ? match[1] : "");
    if (candidate) {
      lastManifestUrl = candidate;
    }
  });

  const networkResponses = new Map();
  client.on("Network.responseReceived", (event) => {
    const url = normalizeHttpUrl(event?.response?.url || "");
    if (!url || !/\.m3u8(?:$|[?#])|\/hls\/|\/stream\/|\/live\/|amazonaws/i.test(url)) return;
    networkResponses.set(event.requestId, url);
    lastManifestUrl = url;
  });
  client.on("Network.loadingFinished", async (event) => {
    if (finished) return;
    const url = networkResponses.get(event.requestId);
    if (!url) return;
    try {
      const bodyResult = await client.send("Network.getResponseBody", {
        requestId: event.requestId,
      });
      const body = bodyResult.base64Encoded
        ? Buffer.from(String(bodyResult.body || ""), "base64").toString("utf8")
        : String(bodyResult.body || "");
      if (!body.trim() || !hasMediaSegments(body, url)) return;
      await finish({
        ok: true,
        manifestUrl: url,
        manifestBody: body,
        referrerUrl: normalizeHttpUrl(page.url()) || channelUrl,
        playbackUrl: channelUrl,
      });
    } catch {}
  });

  try {
    await page.goto(channelUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(12000);
  } catch (error) {
    await finish({
      ok: false,
      error: error instanceof Error ? error.message : String(error || "goto-failed"),
      manifestUrl: lastManifestUrl,
      manifestBody: "",
      referrerUrl: normalizeHttpUrl(page.url()) || channelUrl,
      playbackUrl: channelUrl,
    });
    return;
  }

  await finish({
    ok: false,
    manifestUrl: lastManifestUrl,
    manifestBody: "",
    referrerUrl: normalizeHttpUrl(page.url()) || channelUrl,
    playbackUrl: channelUrl,
  });
}

main().catch(async (error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error || "livekora-direct-failed"),
      manifestUrl: "",
      manifestBody: "",
      referrerUrl: "",
      playbackUrl: channelUrl,
    })
  );
});
