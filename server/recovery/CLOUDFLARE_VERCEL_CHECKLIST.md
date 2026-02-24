# Cloudflare + Vercel Checklist

## Cloudflare (tf-player.site)

1. DNS:
- `A tf-player.site -> OVH_IP` (Proxied orange cloud)
- `A www -> OVH_IP` (Proxied)

2. SSL/TLS:
- Mode: `Full (strict)` (after origin cert is installed)

3. Cache:
- Start simple, then tune rules for HLS carefully.
- Purge cache after major route/security changes.

## Vercel (twofooty project)

Set these env vars:

1. `NEXT_PUBLIC_FORCE_IFRAME_PLAYER=1`
2. `NEXT_PUBLIC_IFRAME_PLAYER_ORIGIN=https://tf-player.site`

Then redeploy.

## OVH app env (tf-player host)

Must stay:

1. `NEXT_PUBLIC_FORCE_IFRAME_PLAYER=0`
2. `NEXT_PUBLIC_IFRAME_PLAYER_ORIGIN=`

Reason:
- Prevent self-iframe loop (`tf-player` embedding itself).

## Quick troubleshooting

1. Browser says `refused to connect`:
- Check `Content-Security-Policy` frame-ancestors.
- Check tf-player env is not `FORCE_IFRAME=1`.

2. Cloudflare 521:
- Origin not reachable on expected port/protocol.
- Verify nginx is running and SSL mode matches origin TLS state.

3. Build fails on OVH:
- Missing `.env.local` keys (`SUPABASE_URL`, `SUPABASE_KEY`).
