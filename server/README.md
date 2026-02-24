# Server Recovery Kit

This folder is a recovery kit for running `tf-player.site` on OVH again from scratch.

## What is inside

1. `server/nginx/tf-player.site.conf`
- Nginx virtual host config used for player-only mode.
- Allows only `/watch/*` and required API/static routes.
- Blocks homepage `/` with `403`.

2. `server/deploy/deploy-tf-player.sh`
- Deploy script used on OVH.
- Pulls latest code from GitHub, installs deps, builds, restarts PM2.
- Forces player-host env safety:
  - `NEXT_PUBLIC_FORCE_IFRAME_PLAYER=0`
  - `NEXT_PUBLIC_IFRAME_PLAYER_ORIGIN=`

3. `server/recovery/OVH_RECOVERY.md`
- End-to-end recovery steps for fresh VPS.

4. `server/recovery/CLOUDFLARE_VERCEL_CHECKLIST.md`
- Required DNS/SSL/env checklist for Cloudflare + Vercel + OVH.

5. `server/recovery/env.example`
- Example env keys only (no secret values).

## Important policy

1. Do not commit real secrets (`SUPABASE_KEY`, passwords, API keys) into git.
2. Keep secrets only in:
- OVH: `/var/www/tf-player/.env.local`
- Vercel Environment Variables
- Cloudflare dashboard

## Normal update flow

1. Update code locally.
2. `git add . && git commit -m "..." && git push`
3. SSH into OVH and run:

```bash
bash /home/ubuntu/deploy-tf-player.sh
```

## One-time OVH setup summary

1. Install `node`, `nginx`, `pm2`, `git`.
2. Place deploy key on OVH for GitHub repo read access.
3. Copy `server/deploy/deploy-tf-player.sh` to `/home/ubuntu/deploy-tf-player.sh`.
4. Copy `server/nginx/tf-player.site.conf` to `/etc/nginx/sites-available/tf-player.site`.
5. Enable site + TLS cert + `pm2 startup`.
