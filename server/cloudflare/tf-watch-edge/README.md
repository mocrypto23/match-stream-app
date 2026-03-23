# tf-watch-edge

Cloudflare Worker + Durable Object for Phase 5B.1.

Current routes:

- `GET /__edge-watch/healthz`
- `GET /__edge-watch/snapshot/:matchId`
- `GET /__edge-watch/ws/:matchId`
- `POST /__edge-watch/publish/:matchId`

Notes:

- This worker is additive and does not replace the current OVH SSE path yet.
- `POST /publish/:matchId` is protected with HMAC headers:
  - `x-tf-edge-timestamp`
  - `x-tf-edge-signature`
- Signature format:
  - `hex(hmac_sha256(secret, "${timestamp}.${rawBody}"))`

Deploy:

```bash
npx wrangler deploy --config server/cloudflare/tf-watch-edge/wrangler.jsonc
```

Set secret:

```bash
npx wrangler secret put WATCH_EDGE_PUBLISH_SECRET --config server/cloudflare/tf-watch-edge/wrangler.jsonc
```
