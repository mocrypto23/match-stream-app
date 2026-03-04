import type { SlotServerId, UiServerId } from "./server-source-policy";
import type { StreamMode } from "./stream-mode";

export type R2ServerState = "ready" | "warming" | "down";

export type R2StatusServerEntry = {
  uiServer: UiServerId;
  slotServer: SlotServerId;
  state: R2ServerState;
  playlistUrl: string | null;
  segmentProbe: "ok" | "fail" | "unknown";
  lastSequenceAgeMs: number | null;
  resolverState: "ok" | "no-candidate" | "probe-failed" | "missing-source" | "unknown";
  resolveReason: string;
  reason: string;
  updatedAt: string;
};

export type MatchR2Status = {
  mode: StreamMode;
  servers: R2StatusServerEntry[];
  updatedAt: string;
};
