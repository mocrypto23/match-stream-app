import { handleRuntimeSessionManifestRequest } from "@/lib/repack-runtime-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleRuntimeSessionManifestRequest(req);
}
