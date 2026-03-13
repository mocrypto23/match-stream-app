import { extractLiveEmbedSessionSnapshot } from "./repack-embed-session";
import { type SlotServerId } from "./server-source-policy";

export async function extractBrowserIngestCandidates(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
}) {
  const result = await extractLiveEmbedSessionSnapshot(input);
  return {
    ok: result.ok,
    playbackUrl: result.playbackUrl,
    error: result.error,
    candidates: result.candidates.map((candidate) => ({
      ingestUrl: candidate.fetchUrl || candidate.targetUrl,
      referrerUrl: candidate.referrerUrl,
      targetUrl: candidate.targetUrl,
      manifestBaseUrl: candidate.manifestBaseUrl,
      manifestBody: candidate.manifestBody,
      score: candidate.score,
      via: candidate.via,
    })),
  };
}
