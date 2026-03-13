import { extractLiveEmbedSessionSnapshot, fetchLiveEmbedAsset } from "./repack-embed-session";

export async function extractPlayerv2BrowserSnapshot(input: {
  sourceUrl: string;
  requestOrigin: string;
  timeoutMs: number;
}) {
  const result = await extractLiveEmbedSessionSnapshot({
    ...input,
    slotServerId: 2,
  });
  return {
    ok: result.ok,
    error: result.error,
    candidates: result.candidates.map((candidate) => ({
      ingestUrl: candidate.fetchUrl || candidate.targetUrl,
      targetUrl: candidate.targetUrl,
      referrerUrl: candidate.referrerUrl,
      manifestBody: candidate.manifestBody,
      manifestBaseUrl: candidate.manifestBaseUrl,
    })),
  };
}

export async function extractPlayerv2BrowserCandidates(input: {
  sourceUrl: string;
  requestOrigin: string;
  timeoutMs: number;
}) {
  const result = await extractPlayerv2BrowserSnapshot(input);
  return {
    ok: result.ok,
    error: result.error,
    candidates: result.candidates.map((candidate) => candidate.ingestUrl),
  };
}

export async function fetchPlayerv2AssetThroughBrowser(input: {
  sourceUrl: string;
  requestOrigin: string;
  assetUrl: string;
  timeoutMs: number;
}) {
  return fetchLiveEmbedAsset({
    ...input,
    slotServerId: 2,
  });
}
