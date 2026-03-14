import type { StreamAgentStatus, StreamSourceState, StreamSourceStatus } from "@/lib/stream-source-types";

export type BeinliveState = StreamSourceState;
export type BeinliveStatus = StreamSourceStatus & { provider: "beinlive"; label: "bein-live"; order: 2 };
export type BeinliveAgentStatus = StreamAgentStatus & { provider: "beinlive" };
