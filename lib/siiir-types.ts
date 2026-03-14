import type { StreamAgentStatus, StreamSourceState, StreamSourceStatus } from "@/lib/stream-source-types";

export type SiiirState = StreamSourceState;
export type SiiirStatus = StreamSourceStatus & { provider: "siiir"; label: "siiir.tv"; order: 3 };
export type SiiirAgentStatus = StreamAgentStatus & { provider: "siiir" };
