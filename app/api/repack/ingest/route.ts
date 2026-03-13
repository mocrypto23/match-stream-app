import { NextResponse } from "next/server";

import { supabaseAdmin } from "../../_supabase";
import { extractBrowserIngestCandidates } from "@/lib/repack-browser-extractor";
import { resolveInternalPlayerOrigin, toAbsoluteInternalUrl } from "@/lib/repack-ingest-gateway";
import {
  getSlotSourceUrlFromRow,
  isIngestCandidateAlignedWithSlotServer,
  isAllowedSourceForSlotServer,
  isValidHttpUrl,
  type SlotServerId,
} from "@/lib/server-source-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_RESOLVE_TIMEOUT_MS =
  Math.max(12_000, Number.parseInt(String(process.env.REPACK_RESOLVE_TIMEOUT_MS || "12000"), 10) || 12_000);
const DEFAULT_FETCH_TIMEOUT_MS = Math.max(
  12_000,
  Number.parseInt(String(process.env.REPACK_AGENT_PREFLIGHT_TIMEOUT_MS || "12000"), 10) || 12_000
);
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type MatchRow = {
  id: number;
  match_key?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  match_start?: string | null;
  match_day?: string | null;
  status_key?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

type FetchManifestResult =
  | {
      ok: true;
      body: string;
      contentType: string;
      finalUrl: string;
      fetchUrl: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
      fetchUrl: string;
      finalUrl: string;
      body: string;
      contentType: string;
    };

function toInt(raw: unknown) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : NaN;
}

function normalizeTeamNameForCompare(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0610-\u061a]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function normalizeTeamAliasForCompare(value: unknown, opts?: { stripGeo?: boolean }) {
  let s = normalizeTeamNameForCompare(value);
  if (!s) return "";
  s = s
    .replace(/^(?:\u0646\u0627\u062f\u064a|\u0641\u0631\u064a\u0642|\u0627\u0644\u0634\u0628\u0627\u0628|\u0633\u064a\u062f\u0627\u062a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a\u0647|\u0645\u0646\u062a\u062e\u0628)/, "")
    .replace(/(?:club|fc|sc|u\d{1,2}|women|youth)$/g, "");
  if (opts?.stripGeo) {
    s = s.replace(
      /(?:\u0627\u0644\u0633\u0639\u0648\u062f\u064a|\u0627\u0644\u0645\u0635\u0631\u064a|\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0645\u063a\u0631\u0628\u064a|\u0627\u0644\u062c\u0632\u0627\u0626\u0631\u064a|\u0627\u0644\u0642\u0637\u0631\u064a|\u0627\u0644\u0643\u0648\u064a\u062a\u064a|\u0627\u0644\u0628\u062d\u0631\u064a\u0646\u064a|\u0627\u0644\u0639\u0645\u0627\u0646\u064a|\u0627\u0644\u0639\u0631\u0627\u0642\u064a|\u0627\u0644\u0633\u0648\u0631\u064a|\u0627\u0644\u0627\u0631\u062f\u0646\u064a|\u0627\u0644\u0623\u0631\u062f\u0646\u064a|\u0627\u0644\u0644\u0628\u0646\u0627\u0646\u064a|\u0627\u0644\u0644\u064a\u0628\u064a|\u0627\u0644\u062a\u0648\u0646\u0633\u064a|\u0627\u0644\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0627\u0644\u0645\u0648\u0631\u064a\u062a\u0627\u0646\u064a)$/g,
      ""
    );
  }
  if (/^(?:\u0627\u0644\u0646\u062c\u0645\u0627\u0644\u0627\u062d\u0645\u0631|\u0633\u0631\u0641\u064a\u0646\u0627\u0632\u0641\u064a\u0632\u062f\u0627|redstar(?:belgrade)?|crvenazvezda)$/i.test(s)) {
    return "redstarbelgrade";
  }
  if (/^(?:\u063a\u0644\u0637\u0647\u0633\u0631\u0627\u064a|\u062c\u0627\u0644\u0627\u062a\u0627\u0633\u0631\u0627\u064a|galatasaray)$/i.test(s)) {
    return "galatasaray";
  }
  if (
    /^(?:\u064a\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|\u064a\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|\u062c\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u062c\u0627\u062c\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|jagiellonia(?:bialystok)?|bialystok)$/i.test(
      s
    )
  ) {
    return "jagielloniabialystok";
  }
  return s.trim();
}

function buildUnorderedTeamPairKey(home: unknown, away: unknown, opts?: { stripGeo?: boolean }) {
  const a = normalizeTeamAliasForCompare(home, opts);
  const b = normalizeTeamAliasForCompare(away, opts);
  if (!a || !b) return "";
  return [a, b].sort().join("|");
}

function matchStartMs(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (!value) return null as number | null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function areSiblingKickoffsClose(left: MatchRow, right: MatchRow) {
  const leftMs = matchStartMs(left.match_start);
  const rightMs = matchStartMs(right.match_start);
  if (leftMs === null || rightMs === null) return true;
  return Math.abs(leftMs - rightMs) <= 6 * 60 * 60 * 1000;
}

function extractDayKeyFromRow(row: MatchRow) {
  const matchDay = String(row.match_day || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(matchDay)) return matchDay;
  const key = String(row.match_key || "");
  const fromKey = key.split("||")[0] || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) return fromKey;
  if (row.match_start) {
    return new Date(row.match_start).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  }
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

function countPresentStreams(row: MatchRow) {
  const urls = [row.stream_url, row.stream_url_2, row.stream_url_3, row.stream_url_4];
  return urls.reduce((n, u) => (isValidHttpUrl(u) ? n + 1 : n), 0);
}

function mergeMissingStreams(base: MatchRow, donor: MatchRow) {
  const next: MatchRow = { ...base };
  if (!isValidHttpUrl(next.stream_url) && isValidHttpUrl(donor.stream_url)) next.stream_url = donor.stream_url;
  if (!isValidHttpUrl(next.stream_url_2) && isValidHttpUrl(donor.stream_url_2)) next.stream_url_2 = donor.stream_url_2;
  if (!isValidHttpUrl(next.stream_url_3) && isValidHttpUrl(donor.stream_url_3)) next.stream_url_3 = donor.stream_url_3;
  if (!isValidHttpUrl(next.stream_url_4) && isValidHttpUrl(donor.stream_url_4)) next.stream_url_4 = donor.stream_url_4;
  if (!next.match_start && donor.match_start) next.match_start = donor.match_start;
  if (!next.match_day && donor.match_day) next.match_day = donor.match_day;
  if (!next.status_key && donor.status_key) next.status_key = donor.status_key;
  return next;
}

async function fetchMatchRowsByDayKey(dayKey: string) {
  const safeDayKey = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDayKey)) return [] as MatchRow[];
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .like("match_key", `${safeDayKey}||%`)
    .limit(300);
  if (error || !Array.isArray(data)) return [] as MatchRow[];
  return data as MatchRow[];
}

async function enrichMatchRowWithDuplicateSiblingStreams(row: MatchRow) {
  const currentPair = buildUnorderedTeamPairKey(row.home_team, row.away_team);
  const currentLoosePair = buildUnorderedTeamPairKey(row.home_team, row.away_team, { stripGeo: true });
  if (!currentPair && !currentLoosePair) return row;
  const sameDayRows = await fetchMatchRowsByDayKey(extractDayKeyFromRow(row));
  if (!sameDayRows.length) return row;

  const siblings = sameDayRows
    .filter((candidate) => Number(candidate.id) !== Number(row.id))
    .filter((candidate) => {
      if (!areSiblingKickoffsClose(row, candidate)) return false;
      const strictPair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team);
      if (currentPair && strictPair && strictPair === currentPair) return true;
      const loosePair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team, { stripGeo: true });
      return !!(currentLoosePair && loosePair && loosePair === currentLoosePair);
    });
  if (!siblings.length) return row;

  const donor = siblings.sort((a, b) => {
    const streamDelta = countPresentStreams(b) - countPresentStreams(a);
    if (streamDelta !== 0) return streamDelta;
    const startA = a.match_start ? new Date(a.match_start).getTime() : 0;
    const startB = b.match_start ? new Date(b.match_start).getTime() : 0;
    if (startB !== startA) return startB - startA;
    return Number(b.id || 0) - Number(a.id || 0);
  })[0];
  if (!donor) return row;
  return mergeMissingStreams(row, donor);
}

function isSlotServerId(value: number): value is SlotServerId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function resolveManifestUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return isValidHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
  }
}

function looksLikeManifestResponse(contentType: string, body: string, finalUrl: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  const url = String(finalUrl || "").toLowerCase();
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return url.includes(".m3u8");
}

function isLikelyChildPlaylistUrl(rawUrl: string) {
  const value = String(rawUrl || "").toLowerCase();
  return value.includes(".m3u8");
}

function hasMediaSegments(manifest: string, baseUrl: string) {
  let previousExtInf = false;
  for (const line of String(manifest || "").split(/\r?\n/)) {
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

    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute) continue;
    if (previousExtInf) return true;
    if (!isLikelyChildPlaylistUrl(absolute)) return true;
    previousExtInf = false;
  }
  return false;
}

function pickVariantManifestUrl(manifest: string, baseUrl: string) {
  let pendingBandwidth = -1;
  const variants: Array<{ url: string; bandwidth: number; order: number }> = [];
  let order = 0;

  for (const line of String(manifest || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match?.[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !isLikelyChildPlaylistUrl(absolute)) {
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
  }

  variants.sort((left, right) => {
    if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth;
    return left.order - right.order;
  });
  return variants[0]?.url || "";
}

async function fetchManifestOnce(fetchUrl: string, headers?: Record<string, string>): Promise<FetchManifestResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(fetchUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
        "user-agent": DEFAULT_USER_AGENT,
        ...(headers || {}),
      },
    });
    const body = await response.text();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || fetchUrl;
    if (!response.ok) {
      return {
        ok: false,
        error: `manifest-http-${response.status || 0}`,
        status: response.status,
        fetchUrl,
        finalUrl,
        body,
        contentType,
      };
    }
    if (!looksLikeManifestResponse(contentType, body, finalUrl)) {
      return {
        ok: false,
        error: "manifest-not-hls",
        status: response.status,
        fetchUrl,
        finalUrl,
        body,
        contentType,
      };
    }
    return {
      ok: true,
      body,
      contentType,
      finalUrl,
      fetchUrl,
    };
  } catch (error) {
    return {
      ok: false,
      error: `manifest-fetch-failed:${error instanceof Error ? error.message : String(error)}`,
      status: 0,
      fetchUrl,
      finalUrl: fetchUrl,
      body: "",
      contentType: "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchStrictMediaManifest(fetchUrl: string, headers?: Record<string, string>) {
  let currentUrl = fetchUrl;
  for (let depth = 0; depth < 3; depth += 1) {
    const fetched = await fetchManifestOnce(currentUrl, headers);
    if (!fetched.ok) return fetched;
    if (hasMediaSegments(fetched.body, fetched.finalUrl)) return fetched;

    const variantUrl = pickVariantManifestUrl(fetched.body, fetched.finalUrl);
    if (!variantUrl) {
      return {
        ok: false,
        error: "manifest-no-media-playlist",
        status: 502,
        fetchUrl: currentUrl,
        finalUrl: fetched.finalUrl,
        body: fetched.body,
        contentType: fetched.contentType,
      } satisfies FetchManifestResult;
    }
    currentUrl = variantUrl;
  }

  return {
    ok: false,
    error: "manifest-recursion-limit",
    status: 502,
    fetchUrl,
    finalUrl: fetchUrl,
    body: "",
    contentType: "",
  } satisfies FetchManifestResult;
}

function absolutizeManifestUrls(manifest: string, baseUrl: string, internalOrigin: string) {
  const lines = String(manifest || "").split(/\r?\n/);
  const out: string[] = [];

  const absolutize = (raw: string) => {
    const value = String(raw || "").trim();
    if (!value || /^data:/i.test(value)) return value;
    try {
      const absolute = new URL(value, baseUrl).toString();
      if (!isValidHttpUrl(absolute)) return value;
      return absolute.startsWith(internalOrigin) ? absolute : toAbsoluteInternalUrl(absolute, internalOrigin);
    } catch {
      return value;
    }
  };

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      out.push(line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => `URI="${absolutize(rawUri)}"`));
      continue;
    }
    out.push(absolutize(trimmed));
  }

  return out.join("\n");
}

async function tryBrowserExtractorManifest(input: {
  sourceUrl: string;
  slotServer: SlotServerId;
  internalOrigin: string;
}) {
  const extracted = await extractBrowserIngestCandidates({
    sourceUrl: input.sourceUrl,
    requestOrigin: input.internalOrigin,
    slotServerId: input.slotServer,
    timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
  });
  const candidatesFound = Array.isArray(extracted.candidates) ? extracted.candidates.length : 0;
  if (!extracted.ok || !Array.isArray(extracted.candidates) || !extracted.candidates.length) {
    return {
      ok: false as const,
      error: extracted.error || "browser-extraction-empty",
      playbackUrl: String(extracted.playbackUrl || "").trim(),
      candidatesFound,
      candidatesTried: 0,
      ingestUrl: "",
      referrerUrl: "",
      targetUrl: "",
      manifestBody: "",
      finalUrl: "",
    };
  }

  let lastError = extracted.error || "browser-extraction-empty";
  let candidatesTried = 0;
  for (const candidate of extracted.candidates) {
    const ingestUrl = String(candidate.ingestUrl || "").trim();
    const targetUrl = String(candidate.targetUrl || "").trim();
    const referrerUrl = String(candidate.referrerUrl || targetUrl || input.sourceUrl).trim() || input.sourceUrl;
    if (!isValidHttpUrl(ingestUrl)) continue;
    if (
      !isIngestCandidateAlignedWithSlotServer({
        slotServerId: input.slotServer,
        sourceUrl: input.sourceUrl,
        ingestUrl,
        probeReferrerUrl: referrerUrl,
        probePlaylistUrl: targetUrl || ingestUrl,
      })
    ) {
      continue;
    }

    candidatesTried += 1;
    const fetchUrl = toAbsoluteInternalUrl(ingestUrl, input.internalOrigin);
    const manifest = await fetchStrictMediaManifest(fetchUrl);
    if (!manifest.ok) {
      lastError = manifest.error || lastError;
      continue;
    }

    return {
      ok: true as const,
      error: "",
      playbackUrl: String(extracted.playbackUrl || "").trim(),
      candidatesFound,
      candidatesTried,
      ingestUrl,
      referrerUrl,
      targetUrl: targetUrl || ingestUrl,
      finalUrl: manifest.finalUrl || fetchUrl,
      manifestBody: absolutizeManifestUrls(manifest.body, manifest.finalUrl || fetchUrl, input.internalOrigin),
    };
  }

  return {
    ok: false as const,
    error: lastError || "browser-extraction-no-verified-manifest",
    playbackUrl: String(extracted.playbackUrl || "").trim(),
    candidatesFound,
    candidatesTried,
    ingestUrl: "",
    referrerUrl: "",
    targetUrl: "",
    manifestBody: "",
    finalUrl: "",
  };
}

async function fetchMatchRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  const enriched = data ? await enrichMatchRowWithDuplicateSiblingStreams(data as MatchRow) : null;
  return {
    data: (enriched || null) as MatchRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const matchId = toInt(url.searchParams.get("matchId"));
  const slotServer = toInt(url.searchParams.get("slotServer"));
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }
  if (!Number.isFinite(slotServer) || !isSlotServerId(slotServer)) {
    return NextResponse.json({ ok: false, error: "invalid-slot-server" }, { status: 400 });
  }

  const internalOrigin = resolveInternalPlayerOrigin(req);
  const { data, error } = await fetchMatchRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const sourceUrl = String(getSlotSourceUrlFromRow(data, slotServer) || "").trim();
  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "missing-source" }, { status: 502 });
  }
  if (!isAllowedSourceForSlotServer(slotServer, sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 502 });
  }

  const browserExtracted = await tryBrowserExtractorManifest({
    sourceUrl,
    slotServer,
    internalOrigin,
  });
  if (browserExtracted.ok) {
    return new Response(browserExtracted.manifestBody, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        "x-repack-gateway": "1",
        "x-repack-slot-server": String(slotServer),
        "x-repack-source-url": sourceUrl,
        "x-repack-upstream-url": browserExtracted.ingestUrl,
        "x-repack-extractor": "browser",
        "x-repack-extractor-candidates-found": String(browserExtracted.candidatesFound),
        "x-repack-extractor-candidates-tried": String(browserExtracted.candidatesTried),
      },
    });
  }
  return NextResponse.json(
    {
      ok: false,
      error: `browser-${browserExtracted.error || "extraction-failed"}`,
      extractor: {
        mode: "browser-only",
        playbackUrl: browserExtracted.playbackUrl || null,
        candidatesFound: browserExtracted.candidatesFound,
        candidatesTried: browserExtracted.candidatesTried,
      },
    },
    { status: 502 }
  );
}
