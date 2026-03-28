import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const VIDEO_FILES: Record<string, string> = {
  interpolated: "korasimo-interpolated.mp4",
  original: "korasimo-original.mp4",
};

function parseRangeHeader(rangeHeader: string | null, size: number) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const [rawStart, rawEnd] = rangeHeader.slice(6).split("-");
  const start = rawStart ? Number.parseInt(rawStart, 10) : 0;
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= size) {
    return null;
  }

  return { end, start };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ variant: string }> },
) {
  const { variant } = await context.params;
  const filename = VIDEO_FILES[variant];
  if (!filename) {
    return NextResponse.json({ error: "unknown-variant" }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), "public", "lab", filename);

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return NextResponse.json({ error: "sample-missing" }, { status: 404 });
  }

  const range = parseRangeHeader(request.headers.get("range"), fileStat.size);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": "video/mp4",
  });

  if (!range) {
    headers.set("Content-Length", String(fileStat.size));
    return new NextResponse(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
      headers,
      status: 200,
    });
  }

  const chunkSize = range.end - range.start + 1;
  headers.set("Content-Length", String(chunkSize));
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${fileStat.size}`);

  return new NextResponse(
    Readable.toWeb(createReadStream(filePath, { end: range.end, start: range.start })) as ReadableStream,
    {
      headers,
      status: 206,
    },
  );
}
