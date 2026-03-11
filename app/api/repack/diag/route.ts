import { NextResponse } from "next/server";

import { getRuntimeRepackFlags } from "@/lib/repack-flags";
import { getRepackBootstrapMetrics } from "@/lib/repack-runtime-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function localAgentUrl(pathname: string) {
  const port = Number.parseInt(String(process.env.REPACK_AGENT_PORT || "3400"), 10) || 3400;
  const bind = String(process.env.REPACK_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1";
  return `http://${bind}:${port}${pathname}`;
}

export async function GET() {
  const flags = getRuntimeRepackFlags();
  const bootstrapMetrics = getRepackBootstrapMetrics();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2200);
  try {
    const upstream = await fetch(localAgentUrl("/diag"), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await upstream.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return NextResponse.json(
      {
        ok: upstream.ok,
        flags: {
          enabled: flags.enabled,
          repackServers: Array.from(flags.repackServers).sort((a, b) => a - b),
          p2pServers: Array.from(flags.p2pServers).sort((a, b) => a - b),
          publicBaseUrl: flags.publicBaseUrl,
        },
        bootstrapMetrics,
        repackAgent: parsed,
      },
      { status: upstream.ok ? 200 : 502 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        flags: {
          enabled: flags.enabled,
          repackServers: Array.from(flags.repackServers).sort((a, b) => a - b),
          p2pServers: Array.from(flags.p2pServers).sort((a, b) => a - b),
          publicBaseUrl: flags.publicBaseUrl,
        },
        bootstrapMetrics,
        error: "repack-agent-unreachable",
        detail: message,
      },
      { status: 503 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
