import type { StreamAgentStatus, StreamSourceStatus } from "@/lib/stream-source-types";

export type YallashootStatus = StreamSourceStatus & { provider: "yallashoot"; label: "yalla-shoot"; order: 4 };
export type YallashootAgentStatus = StreamAgentStatus & { provider: "yallashoot" };

