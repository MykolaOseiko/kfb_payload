#!/bin/bash
set -e

cd /var/www/kf-payload

pm2 stop kf-payload 2>/dev/null || true

git pull

npm ci --silent

export NODE_OPTIONS="--max-old-space-size=400"

npm run build

pm2 restart kf-payload --update-env

echo "✅ Payload deployed!"
