import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveUpstreamFromReferer(req: Request) {
  const referer = req.headers.get("referer");
  if (!referer) return null;

  try {
    const refUrl = new URL(referer);
    const proxiedTarget = refUrl.searchParams.get("url");
    if (proxiedTarget) {
      const decoded = new URL(proxiedTarget);
      return `${decoded.origin}/playerv2.php?action=generate_token`;
    }
  } catch {}

  return null;
}

async function handle(req: Request) {
  try {
    const upstreamUrl = resolveUpstreamFromReferer(req);
    if (!upstreamUrl) {
      return NextResponse.json(
        { error: "Missing upstream context for playerv2.php" },
        { status: 400 }
      );
    }

    const incoming = new Headers(req.headers);
    const headers = new Headers();
    headers.set(
      "user-agent",
      incoming.get("user-agent") ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    );
    headers.set("accept", incoming.get("accept") || "application/json, text/plain, */*");
    headers.set("accept-language", incoming.get("accept-language") || "ar,en-US;q=0.9,en;q=0.8");
    headers.set("content-type", incoming.get("content-type") || "application/x-www-form-urlencoded");
    headers.set("cache-control", "no-cache");
    headers.set("pragma", "no-cache");

    const cookie = incoming.get("cookie");
    if (cookie) headers.set("cookie", cookie);

    const method = String(req.method || "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await req.arrayBuffer() : undefined;

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      redirect: "follow",
      cache: "no-store",
      body,
    });

    const outHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "content-encoding") return;
      if (lower === "set-cookie") {
        outHeaders.append(key, value);
        return;
      }
      outHeaders.set(key, value);
    });
    outHeaders.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
    outHeaders.set("pragma", "no-cache");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Proxy fallback error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

