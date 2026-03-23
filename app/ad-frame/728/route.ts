import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ADSTERRA_BANNER_728_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TwoFooty Sponsor</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #ad-wrap {
        width: 728px;
        height: 90px;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="ad-wrap">
      <script>
        atOptions = {
          key: "6a12e1a77f6425cf6359cb652cff80e3",
          format: "iframe",
          height: 90,
          width: 728,
          params: {}
        };
      </script>
      <script async src="https://www.highperformanceformat.com/6a12e1a77f6425cf6359cb652cff80e3/invoke.js"></script>
    </div>
  </body>
</html>`;

export async function GET() {
  return new NextResponse(ADSTERRA_BANNER_728_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
