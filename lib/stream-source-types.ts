export type StreamProviderId = "livekora" | "beinlive" | "siiir";

export type StreamSourceState = "ready" | "warming" | "down";

export type StreamSourceStatus = {
  provider: StreamProviderId;
  mode: "r2";
  matchId: number;
  sourceUrl: string | null;
  state: StreamSourceState;
  playlistUrl: string | null;
  reason: string;
  currentSource: string | null;
  updatedAt: string;
  label: string;
  order: number;
};

export type StreamAgentStatus = {
  exists: boolean;
  provider: StreamProviderId;
  matchId: number;
  state: StreamSourceState;
  playlistUrl: string | null;
  sourceUrl: string | null;
  currentSource: string | null;
  reason: string;
  updatedAt: string;
};
