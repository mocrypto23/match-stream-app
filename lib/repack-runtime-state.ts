import type { SlotServerId } from "./server-source-policy";

const RUNTIME_STATE_TTL_MS = 10 * 60 * 1000;

export type RepackSeedRuntimeState = {
  accepted: boolean;
  reason: string;
  statusCode: number;
  updatedAt: number;
};

const repackSeedRuntimeState = new Map<string, RepackSeedRuntimeState>();

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

