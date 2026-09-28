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

## Documentación

La documentación técnica y funcional completa (para operación y auditoría)
está en [`docs/`](docs/README.md); el historial de versiones en
[`CHANGELOG.md`](CHANGELOG.md). PDF: `bash docs/generar-pdf.sh`.

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
  - `cartera.js` — cuentas por cobrar (recibos de caja) y por pagar (pagos a proveedores), con antigüedad de saldos.
  - `notas-credito.js` — notas crédito y anulación de facturas de venta.
- `src/dian/cliente.js`, `src/dian/notas.js` — integración con Arco: facturas y notas crédito.
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

## Facturación electrónica DIAN (vía Arco ERP)

La facturación electrónica se hace a través de **Arco ERP** (`src/dian/`):
Arco numera la factura con su resolución, la firma y la transmite a la DIAN.

- `src/dian/arco.js` — cliente HTTP (login → token `OAuth`, renovación automática).
- `src/dian/cliente.js` — `enviarFacturaADian` (Factura/Insert), `sincronizarEstado`
  (Factura/Get → CUFE), `probarConexion` y el job que reintenta cada 2 min.
- Configuración por empresa en `empresa.arco_config` (pantalla **Configuración**,
  solo admin): host, company, user, password, DocumentoId, SucursalId, BodegaId,
  ClienteId de consumidor final. Cada NIT necesita su propia cuenta de Arco.
- Cada producto vendido necesita `arco_producto_id` (el ProductoId con el que
  existe en Arco) y `impuesto_pct` si el precio incluye IVA/impoconsumo.
- Los clientes con documento se crean en Arco (Tercero/Insert + Cliente/Insert)
  la primera vez que se les factura; el id queda en `tercero.arco_cliente_id`.
- Estados en `factura_venta.estado_dian`: pendiente · sin_configurar · enviada ·
  aceptada (CUFE) · error (se reintenta) · rechazada. Mensaje en `dian_mensaje`.
- Variables: `DIAN_JOB=off` desactiva el job (útil en pruebas locales).

Documentación de Arco: https://documenter.getpostman.com/view/289978/UzJFweL6

## Cartera y notas crédito

- `src/routes/cartera.js` — cuentas por cobrar y por pagar propias (no
  dependen de Arco ni del contador): recibos de caja, pagos a proveedores,
  antigüedad de saldos y resumen. El saldo vive en `factura_venta.saldo` /
  `compra.saldo`.
- `src/routes/notas-credito.js` + `src/dian/notas.js` — notas crédito
  (devolución, rebaja, ajuste de precio, descuentos) y anulación de facturas
  ya emitidas electrónicamente. Los nombres exactos de los campos de
  `NotaCredito/Insert`/`NotaCredito/Get` de Arco no están confirmados contra
  su documentación pública (ver docs/05); antes de la primera nota crédito
  real hay que validarlos con Arco y probar contra su simulador.

## Pendiente de decidir

- Si el traslado Agrocarnes → Restaurante / D'Monsa queda como traslado
  interno sin factura o como venta intercompañía — a confirmar con el contador.
- Cuentas de Arco de Agrocarnes y del Restaurante (host, usuario, DocumentoId).
- Dominio definitivo (hoy: subdominios de agrofranpabel.com).
- Confirmar contra Arco los campos exactos de NotaCredito/Insert y
  NotaCredito/Get antes de emitir la primera nota crédito real.
