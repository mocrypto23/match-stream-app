# OVH Recovery (From Zero)

Use this when you need to rebuild `tf-player.site` from scratch.

## 1) Base packages

```bash
sudo apt-get update -y
sudo apt-get install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2
```

## 2) GitHub deploy key

1. Generate key on server:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -C "tf-player-deploy-key" -f ~/.ssh/id_ed25519_github -N ""
```

2. Create SSH config:

```bash
cat > ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
chmod 600 ~/.ssh/config
```

3. Add `~/.ssh/id_ed25519_github.pub` to GitHub repo Deploy Keys (read-only).

## 3) App folder + env

```bash
sudo mkdir -p /var/www
sudo chown -R ubuntu:ubuntu /var/www
git clone --branch main git@github.com:mocrypto23/match-stream-app.git /var/www/tf-player
```

Create `/var/www/tf-player/.env.local` with your real values.

## 4) Deploy script

```bash
cp server/deploy/deploy-tf-player.sh /home/ubuntu/deploy-tf-player.sh
chmod +x /home/ubuntu/deploy-tf-player.sh
bash /home/ubuntu/deploy-tf-player.sh
```

## 5) PM2 startup

```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save
```

## 6) Nginx site

```bash
sudo cp server/nginx/tf-player.site.conf /etc/nginx/sites-available/tf-player.site
sudo ln -sf /etc/nginx/sites-available/tf-player.site /etc/nginx/sites-enabled/tf-player.site
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
```

## 7) TLS with Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tf-player.site -d www.tf-player.site --non-interactive --agree-tos --register-unsafely-without-email --redirect
sudo nginx -t
sudo systemctl restart nginx
```

## 8) Verify

```bash
pm2 status tf-player
curl -I https://tf-player.site/watch/35246
```

Expected:
1. `pm2` status is `online`.
2. `watch` path returns `200`.
