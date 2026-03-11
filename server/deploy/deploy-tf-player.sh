#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/var/www/tf-player
REPO_SSH=git@github.com:mocrypto23/match-stream-app.git
BRANCH=main
ENV_FILE="$APP_DIR/.env.local"
ENV_BACKUP=/home/ubuntu/tf-player.env.local

restore_env_if_needed() {
  if [ ! -f "$ENV_FILE" ] && [ -f "$ENV_BACKUP" ]; then
    cp "$ENV_BACKUP" "$ENV_FILE"
    echo "[deploy] restored .env.local from backup"
  fi
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
pm2 restart tf-repackager --update-env || NODE_ENV=production pm2 start npm --name tf-repackager -- run repackager:start
pm2 restart tf-repack-prewarm --update-env || NODE_ENV=production pm2 start npm --name tf-repack-prewarm -- run repack-prewarm:start
pm2 save
sudo systemctl start nginx || true

echo "[deploy] done"
