import { revalidatePath, revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RevalidateBody = {
  paths?: string[];
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

  return NextResponse.json({
    ok: true,
    revalidated: paths,
    revalidatedTags: ["matches-list"],
    at: new Date().toISOString(),
  });
}
