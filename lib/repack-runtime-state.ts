import type { SlotServerId } from "./server-source-policy";

const RUNTIME_STATE_TTL_MS = 10 * 60 * 1000;
const BOOTSTRAP_REASON_COUNTER_MAX = 240;

export type RepackResolverState = "ok" | "no-candidate" | "probe-failed" | "missing-source" | "unknown";

export type RepackSeedRuntimeState = {
  accepted: boolean;
  reason: string;
  statusCode: number;
  resolverState: RepackResolverState;
  resolveReason: string;
  ingestMode: string;
  ingestUrl: string | null;
  updatedAt: number;
};

const repackSeedRuntimeState = new Map<string, RepackSeedRuntimeState>();
const bootstrapRejectedByReason = new Map<string, number>();
let bootstrapRequests = 0;
let resolverNoCandidateCount = 0;
let probeFailCount = 0;

function runtimeStateKey(matchId: number, slotServerId: SlotServerId) {
  return `${matchId}:${slotServerId}`;
}

function trimRuntimeState(now = Date.now()) {
  for (const [key, value] of repackSeedRuntimeState.entries()) {
    if (now - value.updatedAt > RUNTIME_STATE_TTL_MS) repackSeedRuntimeState.delete(key);
  }
}

export function setRepackSeedRuntimeState(
  matchId: number,
  slotServerId: SlotServerId,
  input: Omit<RepackSeedRuntimeState, "updatedAt"> & { updatedAt?: number }
) {
  trimRuntimeState();
  const next: RepackSeedRuntimeState = {
    accepted: Boolean(input.accepted),
    reason: String(input.reason || "").trim() || "unknown",
    statusCode: Number.isFinite(input.statusCode) ? Number(input.statusCode) : 0,
    resolverState:
      String(input.resolverState || "").trim() === "ok" ||
      String(input.resolverState || "").trim() === "no-candidate" ||
      String(input.resolverState || "").trim() === "probe-failed" ||
      String(input.resolverState || "").trim() === "missing-source"
        ? (input.resolverState as RepackResolverState)
        : "unknown",
    resolveReason: String(input.resolveReason || "").trim() || "unknown",
    ingestMode: String(input.ingestMode || "").trim() || "none",
    ingestUrl: typeof input.ingestUrl === "string" && input.ingestUrl.trim() ? input.ingestUrl.trim() : null,
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
  };
  repackSeedRuntimeState.set(runtimeStateKey(matchId, slotServerId), next);
}

export function getRepackSeedRuntimeState(matchId: number, slotServerId: SlotServerId) {
  trimRuntimeState();
  return repackSeedRuntimeState.get(runtimeStateKey(matchId, slotServerId)) || null;
}

export function listRepackSeedRuntimeStateForMatch(matchId: number) {
  trimRuntimeState();
  const out: Array<{ slotServer: SlotServerId; state: RepackSeedRuntimeState }> = [];
  for (const slotServerId of [1, 2, 3, 4] as const) {
    const state = getRepackSeedRuntimeState(matchId, slotServerId);
    if (!state) continue;
    out.push({ slotServer: slotServerId, state });
  }
  return out;
}

function trimReasonCounters() {
  if (bootstrapRejectedByReason.size <= BOOTSTRAP_REASON_COUNTER_MAX) return;
  const entries = Array.from(bootstrapRejectedByReason.entries()).sort((a, b) => b[1] - a[1]);
  bootstrapRejectedByReason.clear();
  for (const [key, value] of entries.slice(0, BOOTSTRAP_REASON_COUNTER_MAX)) {
    bootstrapRejectedByReason.set(key, value);
  }
}

export function noteRepackBootstrapRequest() {
  bootstrapRequests += 1;
}

export function noteRepackBootstrapOutcome(input: {
  accepted: boolean;
  reason: string;
  resolverState?: RepackResolverState | null;
}) {
  if (input.accepted) return;
  const reason = String(input.reason || "").trim() || "unknown";
  bootstrapRejectedByReason.set(reason, (bootstrapRejectedByReason.get(reason) || 0) + 1);
  trimReasonCounters();

  const resolverState = String(input.resolverState || "").trim().toLowerCase();
  if (resolverState === "no-candidate") resolverNoCandidateCount += 1;
  if (resolverState === "probe-failed") probeFailCount += 1;
}

export function getRepackBootstrapMetrics() {
  const rejected = Object.fromEntries(
    Array.from(bootstrapRejectedByReason.entries()).sort((a, b) => b[1] - a[1])
  );
  return {
    bootstrapRequests,
    bootstrapRejectedByReason: rejected as Record<string, number>,
    resolverNoCandidateCount,
    probeFailCount,
  };
}
