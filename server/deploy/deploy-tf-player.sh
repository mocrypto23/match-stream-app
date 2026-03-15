#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/var/www/tf-player
REPO_SSH=git@github.com:mocrypto23/match-stream-app.git
BRANCH=main
ENV_FILE="$APP_DIR/.env.local"
ENV_BACKUP=/home/ubuntu/tf-player.env.local
NGINX_SOURCE_CONFIG="$APP_DIR/server/nginx/tf-player.site.conf"
NGINX_TARGET_CONFIG=/etc/nginx/sites-available/tf-player.site

restore_env_if_needed() {
  if [ ! -f "$ENV_FILE" ] && [ -f "$ENV_BACKUP" ]; then
    cp "$ENV_BACKUP" "$ENV_FILE"
    echo "[deploy] restored .env.local from backup"
  fi
}

sync_nginx_config() {
  if [ ! -f "$NGINX_SOURCE_CONFIG" ]; then
    echo "[deploy] skipping nginx sync: missing source config"
    return
  fi

  if [ -f "$NGINX_TARGET_CONFIG" ] && cmp -s "$NGINX_SOURCE_CONFIG" "$NGINX_TARGET_CONFIG"; then
    echo "[deploy] nginx config already up to date"
    return
  fi

  sudo cp "$NGINX_SOURCE_CONFIG" "$NGINX_TARGET_CONFIG"
  sudo ln -sf "$NGINX_TARGET_CONFIG" /etc/nginx/sites-enabled/tf-player.site
  sudo nginx -t
  sudo systemctl reload nginx || sudo systemctl restart nginx || true
  echo "[deploy] synced nginx config"
}

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[deploy] first-time clone..."
  sudo systemctl stop nginx || true

  if [ -d "$APP_DIR" ]; then
    if [ -f "$APP_DIR/.env.local" ]; then
      cp "$APP_DIR/.env.local" "$ENV_BACKUP"
      chmod 600 "$ENV_BACKUP"
      echo "[deploy] backed up existing .env.local"
    fi
    sudo mv "$APP_DIR" "$APP_DIR.snapshot.$(date +%Y%m%d-%H%M%S)"
  fi

  sudo mkdir -p /var/www
  sudo chown -R ubuntu:ubuntu /var/www
  git clone --branch "$BRANCH" "$REPO_SSH" "$APP_DIR"
fi

cd "$APP_DIR"
restore_env_if_needed

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# In case checkout removed .env.local (e.g. first clone path).
restore_env_if_needed

if [ ! -f "$ENV_FILE" ]; then
  echo "[deploy] ERROR: missing .env.local at $ENV_FILE"
  echo "[deploy] create it once, then rerun."
  exit 1
fi

# Keep tf-player host as real player (not iframe host).
sed -i '/^NEXT_PUBLIC_FORCE_IFRAME_PLAYER=/d' "$ENV_FILE" || true
sed -i '/^NEXT_PUBLIC_IFRAME_PLAYER_ORIGIN=/d' "$ENV_FILE" || true
echo 'NEXT_PUBLIC_FORCE_IFRAME_PLAYER=0' >> "$ENV_FILE"
echo 'NEXT_PUBLIC_IFRAME_PLAYER_ORIGIN=' >> "$ENV_FILE"

npm ci --no-audit --no-fund
npm run build
pm2 restart tf-player --update-env || PORT=3000 NODE_ENV=production pm2 start npm --name tf-player -- start
pm2 delete tf-repackager >/dev/null 2>&1 || true
pm2 delete tf-repack-prewarm >/dev/null 2>&1 || true
pm2 restart livekora-r2-agent --update-env || NODE_ENV=production pm2 start server/livekora-r2-agent/index.js --name livekora-r2-agent --cwd "$APP_DIR"
pm2 save
sync_nginx_config
sudo systemctl start nginx || true

echo "[deploy] done"
