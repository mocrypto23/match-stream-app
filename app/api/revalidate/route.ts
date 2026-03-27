import { revalidatePath, revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

import { readMatchesForDay } from "@/lib/home-matches";
import { cairoDayStringFromOffset } from "@/lib/home-page-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RevalidateBody = {
  paths?: string[];
};

type PrewarmResult = {
  ok: boolean;
  status?: number;
  url?: string;
  error?: string;
};

function getProvidedSecret(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }

  return (req.headers.get("x-revalidate-secret") ?? "").trim();
}

function normalizePaths(paths: unknown) {
  if (!Array.isArray(paths)) return ["/", "/watch/[id]"];

  const valid = paths.filter((p): p is string => typeof p === "string" && p.startsWith("/"));
  if (!valid.length) return ["/", "/watch/[id]"];

  return [...new Set(valid)];
}

function resolveRequestOrigin(req: NextRequest) {
  const explicitOrigin =
    (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim() ||
    (process.env.SITE_URL ?? "").trim();
  if (explicitOrigin) {
    return explicitOrigin.replace(/\/+$/, "");
  }

  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").trim();
  const forwardedHost = (req.headers.get("x-forwarded-host") ?? "").trim();
  const host = forwardedHost || (req.headers.get("host") ?? "").trim();
  if (host) {
    const proto = forwardedProto || req.nextUrl.protocol.replace(/:$/, "") || "https";
    return `${proto}://${host}`;
  }

  return req.nextUrl.origin.replace(/\/+$/, "");
}

async function prewarmHomeHtml(req: NextRequest): Promise<PrewarmResult> {
  const url = `${resolveRequestOrigin(req)}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "user-agent": "twofooty-revalidate-prewarm/1.0",
        "x-twofooty-prewarm": "1",
      },
    });

    await response.text();

    return {
      ok: response.ok,
      status: response.status,
      url,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: NextRequest) {
  const expectedSecret = (process.env.REVALIDATE_SECRET ?? "").trim();
  if (!expectedSecret) {
    return NextResponse.json({ error: "Server revalidate secret is missing" }, { status: 500 });
  }

  const providedSecret = getProvidedSecret(req);
  if (!providedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RevalidateBody = {};
  try {
    body = (await req.json()) as RevalidateBody;
  } catch {
    body = {};
  }

  const paths = normalizePaths(body.paths);

  for (const path of paths) {
    if (path.includes("[") && path.includes("]")) {
      revalidatePath(path, "page");
      continue;
    }

    revalidatePath(path);
  }

  // Keep matches API data cache aligned with scraper cron updates.
  revalidateTag("matches-list", "max");

  const prewarmedDays: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const day = cairoDayStringFromOffset(offset);
    try {
      await readMatchesForDay(day);
      prewarmedDays.push(day);
    } catch {}
  }

  let prewarmedHome: PrewarmResult | null = null;
  if (paths.includes("/")) {
    prewarmedHome = await prewarmHomeHtml(req);
  }

  return NextResponse.json({
    ok: true,
    revalidated: paths,
    revalidatedTags: ["matches-list"],
    prewarmedDays,
    prewarmedHome,
    at: new Date().toISOString(),
  });
}
