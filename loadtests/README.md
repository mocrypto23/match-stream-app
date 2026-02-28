# k6 Live Stream Load Test

This script measures real stream traffic by requesting:

1. `GET /api/match/:id` to resolve active source URLs.
2. `GET /api/embed-proxy?...` page/manifest.
3. `GET` HLS manifest(s) (`.m3u8`).
4. `GET` media segments (`.ts/.m4s/...`).

Script path:

- `loadtests/k6-live-stream.js`

## Run Locally

Install k6 (Windows):

```powershell
choco install k6
```

Basic run:

```powershell
k6 run -e BASE_URL=https://tf-player.site -e MATCH_ID=37687 -e SERVER=4 -e VUS=50 -e DURATION=2m .\loadtests\k6-live-stream.js
```

Ramp run:

```powershell
k6 run -e BASE_URL=https://tf-player.site -e MATCH_ID=37687 -e SERVER=4 -e STAGES="2m:50,3m:150,3m:300,2m:0" .\loadtests\k6-live-stream.js
```

## Run In Grafana Cloud k6

```powershell
k6 cloud -e BASE_URL=https://tf-player.site -e MATCH_ID=37687 -e SERVER=4 -e STAGES="2m:50,3m:150,3m:300,2m:0" .\loadtests\k6-live-stream.js
```

## Useful Env Vars

- `BASE_URL` default: `https://tf-player.site`
- `MATCH_ID` default: `37687`
- `SERVER` default: `4` (maps to `stream_url_4`)
- `STREAM_FIELD` example: `stream_url_2` (overrides `SERVER`)
- `SOURCE_URL` explicit upstream page URL (skips match API URL selection)
- `MANIFEST_URL` explicit `.m3u8` URL
- `SEGMENTS_PER_LOOP` default: `2`
- `LOOP_SLEEP_SEC` default: `1`
- `VUS`, `DURATION` for fixed load mode
- `STAGES` for ramping mode: `"2m:50,3m:150,2m:0"`

## Notes

- If stream host blocks bots/rate (403/429), tune WAF or whitelist k6 load zone IPs.
- Start from small load, then ramp up gradually during a live match.
