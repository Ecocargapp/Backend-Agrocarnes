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
- `src/dian/cliente.js`, `src/dian/notas.js` — despachan a Arco o Factus según `empresa.proveedor_dian`.
- `src/dian/arco.js`, `src/dian/facturas-factus.js`, `src/dian/notas-factus.js`, `src/dian/factus.js` — clientes e implementación por proveedor.
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

## Facturación electrónica DIAN (Arco o Factus, por empresa)

Cada empresa elige su proveedor de facturación electrónica con
`empresa.proveedor_dian` (`arco` | `factus`, pantalla **Configuración**):
`src/dian/cliente.js` y `src/dian/notas.js` despachan a la implementación
correspondiente. Factus se agregó en paralelo a Arco (no lo reemplaza en
código, solo se puede elegir por empresa) mientras se completa la migración.

**Arco ERP** — Arco numera la factura con su resolución, la firma y la
transmite a la DIAN.
- `src/dian/arco.js` — cliente HTTP (login → token `OAuth`, renovación automática).
- `src/dian/cliente.js` / `src/dian/notas.js` (funciones `*Arco`) —
  `Factura/Insert` + `Factura/Get` (CUFE), `NotaCredito/Insert` + `NotaCredito/Get`.
- Configuración por empresa en `empresa.arco_config`: host, company, user,
  password, DocumentoId, SucursalId, BodegaId, ClienteId de consumidor final.
- Cada producto vendido necesita `arco_producto_id` y `impuesto_pct`.
- Documentación de Arco: https://documenter.getpostman.com/view/289978/UzJFweL6

**Factus** (`developers.factus.com.co`) — valida y firma en la misma llamada
(normalmente ya devuelve el CUFE de inmediato).
- `src/dian/factus.js` — cliente HTTP (OAuth2 `password` grant + refresh token).
- `src/dian/facturas-factus.js` / `src/dian/notas-factus.js` —
  `POST /v2/bills/validate`, `POST /v2/credit-notes/validate`.
- Configuración por empresa en `empresa.factus_config`: base_url (sandbox o
  producción), client_id, client_secret, email, password, rangos de
  numeración de facturas y notas crédito, cliente por defecto.
- Cada producto vendido puede tener `factus_unidad_medida_code` (si está
  vacío se infiere de `unidad_medida`) y usa el mismo `impuesto_pct`.
- Probado contra el sandbox real de Factus (login, rangos de numeración,
  factura y nota crédito) — ver docs/05 para el detalle y los pendientes
  antes de facturar de verdad.

Comunes a ambos proveedores:
- Estados en `factura_venta.estado_dian` / `nota_credito.estado_dian`:
  pendiente · sin_configurar · enviada · aceptada (CUFE) · error (se
  reintenta) · rechazada. Mensaje en `dian_mensaje`.
- Variables: `DIAN_JOB=off` desactiva el job de reintentos (útil en pruebas locales).

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
