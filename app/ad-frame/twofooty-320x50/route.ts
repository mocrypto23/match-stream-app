import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ADSTERRA_TWOFOOTY_BANNER_320_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TwoFooty Mobile Sponsor</title>
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
        width: 320px;
        height: 50px;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="ad-wrap">
      <script>
        atOptions = {
          key: "210bf9145dece915f045dc46ea603e56",
          format: "iframe",
          height: 50,
          width: 320,
          params: {}
        };
      </script>
      <script async src="https://www.highperformanceformat.com/210bf9145dece915f045dc46ea603e56/invoke.js"></script>
    </div>
  </body>
</html>`;

export async function GET() {
  return new NextResponse(ADSTERRA_TWOFOOTY_BANNER_320_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
