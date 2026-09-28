#!/usr/bin/env bash
# Respaldo diario de la base de datos agrocarnes.
# Lo instala setup-servidor.sh en cron (02:30 todos los días). Uso manual:
#   bash /var/www/agrocarnes-backend/scripts/respaldo-bd.sh
# Deja archivos comprimidos en /var/backups/agrocarnes y conserva 30 días.
set -euo pipefail

DEST=/var/backups/agrocarnes
DIAS=30
ENV_FILE="$(dirname "$0")/../.env"

set -a; . "$ENV_FILE"; set +a
sudo mkdir -p "$DEST"
sudo chown "$(id -u):$(id -g)" "$DEST"
chmod 700 "$DEST"

ARCHIVO="$DEST/agrocarnes-$(date +%Y%m%d-%H%M%S).sql.gz"
PGPASSWORD="$PGPASSWORD" pg_dump -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" \
  --no-owner --no-privileges | gzip -9 > "$ARCHIVO"
chmod 600 "$ARCHIVO"

find "$DEST" -name 'agrocarnes-*.sql.gz' -mtime +"$DIAS" -delete
echo "Respaldo OK: $ARCHIVO ($(du -h "$ARCHIVO" | cut -f1))"
