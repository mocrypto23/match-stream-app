export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function empty() {
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export async function POST() {
  return empty();
}

export async function GET() {
  return empty();
}

