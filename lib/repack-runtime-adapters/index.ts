import { albaRuntimeAdapter } from "./alba";
import { beinRuntimeAdapter } from "./bein";
import { defaultRuntimeAdapter } from "./default";
import { playerv2RuntimeAdapter } from "./playerv2";
import type { RuntimeAdapter, RuntimeAdapterInput } from "./shared";

const runtimeAdapters: RuntimeAdapter[] = [playerv2RuntimeAdapter, beinRuntimeAdapter, albaRuntimeAdapter, defaultRuntimeAdapter];

export function pickRuntimeAdapter(input: RuntimeAdapterInput) {
  return runtimeAdapters.find((adapter) => adapter.matches(input)) || runtimeAdapters[runtimeAdapters.length - 1];
}

export type { RuntimeAdapter, RuntimeAdapterInput, RuntimeAdapterKind, RuntimeManifestResult } from "./shared";
