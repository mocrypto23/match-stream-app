export type LivekoraState = "ready" | "warming" | "down";

export type LivekoraStatus = {
  provider: "livekora";
  mode: "livekora_r2";
  matchId: number;
  sourceUrl: string | null;
  state: LivekoraState;
  playlistUrl: string | null;
  reason: string;
  currentSource: string | null;
  updatedAt: string;
};

export type LivekoraAgentStatus = {
  exists: boolean;
  matchId: number;
  state: LivekoraState;
  playlistUrl: string | null;
  sourceUrl: string | null;
  currentSource: string | null;
  reason: string;
  updatedAt: string;
};
