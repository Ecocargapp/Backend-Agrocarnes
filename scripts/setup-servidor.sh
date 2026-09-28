#!/usr/bin/env bash
# =============================================================================
# Instalación / actualización de Agrocarnes en el servidor (Ubuntu, usuario
# ubuntu). Convive con AgroSoft en la misma máquina sin tocar nada suyo.
#
# Uso (una sola línea, desde la terminal del servidor):
#   bash <(curl -fsSL https://raw.githubusercontent.com/Ecocargapp/Backend-Agrocarnes/main/scripts/setup-servidor.sh) correo-del-admin@ejemplo.com
#
# Es idempotente: se puede volver a correr para actualizar (hace git pull,
# migraciones pendientes y reinicia pm2) sin duplicar nada.
# =============================================================================
set -euo pipefail

ADMIN_EMAIL="${1:-}"
APP_DOMAIN="agrocarnes.agrofranpabel.com"
API_DOMAIN="api-agrocarnes.agrofranpabel.com"
BACKEND_REPO="https://github.com/Ecocargapp/Backend-Agrocarnes.git"
FRONTEND_REPO="https://github.com/Ecocargapp/Frontend-Agrocarnes.git"
BACKEND_DIR="/var/www/agrocarnes-backend"
FRONTEND_DIR="/var/www/app-agrocarnes"
DB_NAME="agrocarnes"
DB_USER="agrocarnes_app"
API_PORT="4001"

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- requisitos
log "Verificando herramientas"
for bin in git node npm pm2 psql nginx; do
  command -v "$bin" >/dev/null || { echo "Falta $bin en el servidor"; exit 1; }
done
echo "node $(node -v) · npm $(npm -v) · pm2 $(pm2 -v) · $(psql --version)"

# ------------------------------------------------------------- base de datos
log "Base de datos '$DB_NAME' (separada de la de AgroSoft)"
DB_EXISTS=$(sudo -u postgres psql -tAc "select 1 from pg_database where datname='$DB_NAME'")
USER_EXISTS=$(sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='$DB_USER'")

if [ "$USER_EXISTS" != "1" ]; then
  DB_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -qc "create user $DB_USER with password '$DB_PASS';"
  echo "Usuario $DB_USER creado."
else
  DB_PASS=""
  echo "Usuario $DB_USER ya existe."
fi

if [ "$DB_EXISTS" != "1" ]; then
  sudo -u postgres psql -qc "create database $DB_NAME owner $DB_USER;"
  echo "Base de datos $DB_NAME creada."
else
  echo "Base de datos $DB_NAME ya existe."
fi
sudo -u postgres psql -qd "$DB_NAME" -c "grant all on schema public to $DB_USER;" >/dev/null

# ------------------------------------------------------------------ backend
log "Backend → $BACKEND_DIR"
if [ ! -d "$BACKEND_DIR/.git" ]; then
  sudo mkdir -p "$BACKEND_DIR"
  sudo chown "$USER:$USER" "$BACKEND_DIR"
  git clone -q "$BACKEND_REPO" "$BACKEND_DIR"
else
  git -C "$BACKEND_DIR" pull -q
fi
cd "$BACKEND_DIR"

if [ ! -f .env ]; then
  if [ -z "$DB_PASS" ]; then
    # El usuario de BD ya existía pero no hay .env: fijamos una clave nueva.
    DB_PASS=$(openssl rand -hex 24)
    sudo -u postgres psql -qc "alter user $DB_USER with password '$DB_PASS';"
  fi
  cat > .env <<EOF
PORT=$API_PORT
NODE_ENV=production

PGHOST=localhost
PGPORT=5432
PGDATABASE=$DB_NAME
PGUSER=$DB_USER
PGPASSWORD=$DB_PASS

JWT_SECRET=$(openssl rand -hex 48)
JWT_EXPIRES_IN=12h

CORS_ORIGIN=https://$APP_DOMAIN,http://$APP_DOMAIN
EOF
  chmod 600 .env
  echo ".env creado con credenciales generadas."
else
  echo ".env ya existe, se conserva."
fi

log "Dependencias y migraciones"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm run migrate

# ------------------------------------------------------------- usuario admin
ADMIN_PASS=""
if [ -n "$ADMIN_EMAIL" ]; then
  set -a; . ./.env; set +a
  HAY_ADMIN=$(PGPASSWORD="$PGPASSWORD" psql -h localhost -U "$PGUSER" -d "$PGDATABASE" -tAc "select 1 from usuario where email='$ADMIN_EMAIL'")
  if [ "$HAY_ADMIN" != "1" ]; then
    ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)
    node scripts/crear_admin.js "$ADMIN_EMAIL" "$ADMIN_PASS" "Administrador" >/dev/null
    log "Usuario admin creado"
  else
    echo "El usuario admin $ADMIN_EMAIL ya existe."
  fi
fi

# ---------------------------------------------------------------------- pm2
log "Proceso pm2 'agrocarnes-api' (independiente de agrosoft-api)"
if pm2 describe agrocarnes-api >/dev/null 2>&1; then
  pm2 restart agrocarnes-api --update-env >/dev/null
else
  pm2 start ecosystem.config.js >/dev/null
fi
pm2 save >/dev/null
sleep 2
curl -fsS "http://127.0.0.1:$API_PORT/health" && echo "  ← API respondiendo"

# ----------------------------------------------------------------- frontend
log "Frontend → $FRONTEND_DIR"
if [ ! -d "$FRONTEND_DIR/.git" ]; then
  sudo mkdir -p "$FRONTEND_DIR"
  sudo chown "$USER:$USER" "$FRONTEND_DIR"
  git clone -q "$FRONTEND_REPO" "$FRONTEND_DIR"
else
  git -C "$FRONTEND_DIR" pull -q
fi

# -------------------------------------------------------------------- nginx
log "Nginx (server blocks propios, no se tocan los de AgroSoft)"
sudo cp "$BACKEND_DIR/nginx/agrocarnes.conf" /etc/nginx/sites-available/agrocarnes.conf
sudo ln -sf /etc/nginx/sites-available/agrocarnes.conf /etc/nginx/sites-enabled/agrocarnes.conf
sudo nginx -t
sudo systemctl reload nginx

# ------------------------------------------------------------------- https
MI_IP=$(curl -fsS https://checkip.amazonaws.com || true)
DNS_APP=$(getent hosts "$APP_DOMAIN" | awk '{print $1}' || true)
DNS_API=$(getent hosts "$API_DOMAIN" | awk '{print $1}' || true)
if [ -n "$MI_IP" ] && [ "$DNS_APP" = "$MI_IP" ] && [ "$DNS_API" = "$MI_IP" ]; then
  if ! sudo test -d "/etc/letsencrypt/live/$APP_DOMAIN"; then
    log "HTTPS con Certbot"
    sudo certbot --nginx -n --agree-tos --redirect -m "${ADMIN_EMAIL:-admin@agrofranpabel.com}" \
      -d "$APP_DOMAIN" -d "$API_DOMAIN" || warn "Certbot falló; la app queda en HTTP por ahora."
  else
    echo "Certificado HTTPS ya existe."
  fi
else
  warn "DNS todavía no apunta a este servidor ($MI_IP): $APP_DOMAIN→${DNS_APP:-sin registro}, $API_DOMAIN→${DNS_API:-sin registro}."
  warn "Crea los registros A en GoDaddy y vuelve a correr este script para activar HTTPS."
fi

# ------------------------------------------------------------------ resumen
log "Agrocarnes desplegado"
echo "  App:  http://$APP_DOMAIN   (https cuando el DNS esté listo)"
echo "  API:  http://$API_DOMAIN/health"
echo "  pm2:  agrocarnes-api (puerto $API_PORT) · agrosoft-api intacto"
pm2 ls
if [ -n "$ADMIN_PASS" ]; then
  echo
  echo "  ==========================================================="
  echo "   Usuario admin:  $ADMIN_EMAIL"
  echo "   Contraseña:     $ADMIN_PASS"
  echo "   (guárdala; no se vuelve a mostrar)"
  echo "  ==========================================================="
fi
