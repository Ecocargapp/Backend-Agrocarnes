# Backend-Agrocarnes

API de inventario, compras, traslados, producción, ventas y facturación
electrónica para **Agrocarnes**, el **Restaurante** y **D'Monsa Alimentos**.
El frontend vive en [Frontend-Agrocarnes](https://github.com/Ecocargapp/Frontend-Agrocarnes).

Corre en el **mismo servidor EC2 que AgroSoft**, pero con infraestructura
completamente separada: su propia base de datos, su propio proceso pm2, sus
propios archivos estáticos y sus propios subdominios. Nada se comparte con
AgroSoft salvo la máquina física.

| | AgroSoft | Agrocarnes |
| --- | --- | --- |
| Base de datos | `agrosoft` | `agrocarnes` (usuario `agrocarnes_app`) |
| Proceso pm2 | `agrosoft-api` | `agrocarnes-api` (puerto 4001) |
| Código en servidor | (el actual) | `/var/www/agrocarnes-backend` |
| Frontend estático | `/var/www/app-agrofranpabel/` | `/var/www/app-agrocarnes/` |
| API | `api.agrofranpabel.com` | `api-agrocarnes.agrofranpabel.com` |
| App | `app.agrofranpabel.com` | `agrocarnes.agrofranpabel.com` |

## Qué hay en este repo

- `src/server.js` — Express (módulos ES), JWT, CORS. Rutas en `src/routes/`.
- `migrations/001_init.sql` — modelo de datos multiempresa (Agrocarnes,
  Restaurante y D'Monsa comparten la base de datos pero cada una es su propia
  empresa, con su propia bodega y su propia habilitación DIAN).
- `src/db/inventario.js` — la única función que mueve inventario
  (`registrarMovimiento`); todas las rutas la usan, para que el saldo nunca se
  desincronice del kardex. Costo promedio ponderado en cada entrada.
- `src/routes/`
  - `compras.js` — factura de compra a proveedores externos (ej. Agro Franpabel → Agrocarnes / D'Monsa); entra inventario al costo facturado.
  - `traslados.js` — Agrocarnes → Restaurante / D'Monsa, al costo, sin factura. Columna `es_venta_intercompania` lista por si el contador pide facturarlo.
  - `produccion.js` — corre una receta (BOM): consume insumos, entra el terminado con su costo calculado.
  - `ventas.js` — venta al cliente final; descuenta inventario y dispara el envío a la DIAN en segundo plano.
- `src/dian/cliente.js` — el único archivo que se llena cuando se elija el
  proveedor tecnológico de facturación electrónica. Hoy es un placeholder.
- `nginx/agrocarnes.conf` — server blocks separados de los de AgroSoft.
- `ecosystem.config.cjs` — proceso pm2 `agrocarnes-api`.

## Instalación local

```bash
npm install
cp .env.example .env     # edita PGPASSWORD, JWT_SECRET, CORS_ORIGIN
npm run migrate          # corre migrations/*.sql en orden
node scripts/crear_admin.js tu-email@ejemplo.com "tu-clave" "Tu Nombre"
npm run dev              # http://localhost:4001/health
```

## Despliegue en el servidor

### 1. Base de datos separada de la de AgroSoft

```bash
sudo -u postgres psql
CREATE DATABASE agrocarnes;
CREATE USER agrocarnes_app WITH PASSWORD 'una-clave-segura';
GRANT ALL PRIVILEGES ON DATABASE agrocarnes TO agrocarnes_app;
\c agrocarnes
GRANT ALL ON SCHEMA public TO agrocarnes_app;
\q
```

### 2. Backend

```bash
sudo git clone https://github.com/Ecocargapp/Backend-Agrocarnes.git /var/www/agrocarnes-backend
sudo chown -R $USER:$USER /var/www/agrocarnes-backend
cd /var/www/agrocarnes-backend
cp .env.example .env     # edítalo con las credenciales reales
npm install --omit=dev
npm run migrate
node scripts/crear_admin.js tu-email@ejemplo.com "tu-clave" "Tu Nombre"

pm2 start ecosystem.config.cjs
pm2 save                 # sobrevive al reinicio, igual que agrosoft-api
curl http://127.0.0.1:4001/health
```

### 3. Frontend

```bash
sudo git clone https://github.com/Ecocargapp/Frontend-Agrocarnes.git /var/www/app-agrocarnes
```

### 4. Nginx + HTTPS

Requiere dos registros **A** en GoDaddy apuntando a la IP del servidor:
`agrocarnes.agrofranpabel.com` y `api-agrocarnes.agrofranpabel.com`.

```bash
sudo cp nginx/agrocarnes.conf /etc/nginx/sites-available/agrocarnes.conf
sudo ln -s /etc/nginx/sites-available/agrocarnes.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d agrocarnes.agrofranpabel.com -d api-agrocarnes.agrofranpabel.com
```

### Despliegues siguientes (mismo flujo push → pull de AgroSoft)

```bash
cd /var/www/agrocarnes-backend && git pull && npm install --omit=dev && npm run migrate && pm2 restart agrocarnes-api
cd /var/www/app-agrocarnes && git pull
```

## Facturación electrónica DIAN

`src/dian/cliente.js` es el único punto de integración: arma el JSON de la
factura, hace el POST al proveedor tecnológico con las credenciales de la
empresa emisora, y guarda `cufe`, `xml_url`, `pdf_url` y `estado_dian` en
`factura_venta`. Como cada empresa (Agrocarnes, Restaurante) probablemente
tiene NIT propio, cada una necesita su propia habilitación y certificado ante
la DIAN, aunque compartan este mismo sistema.

## Pendiente de decidir

- Si el traslado Agrocarnes → Restaurante / D'Monsa queda como traslado
  interno sin factura o como venta intercompañía — a confirmar con el contador.
- Proveedor tecnológico de facturación electrónica.
- Dominio definitivo (hoy: subdominios de agrofranpabel.com).
