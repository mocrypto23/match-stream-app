import type { StreamAgentStatus, StreamSourceState, StreamSourceStatus } from "@/lib/stream-source-types";

export type LivekoraState = StreamSourceState;
export type LivekoraStatus = StreamSourceStatus & { provider: "livekora"; label: "livekora vip"; order: 1 };
export type LivekoraAgentStatus = StreamAgentStatus & { provider: "livekora" };
