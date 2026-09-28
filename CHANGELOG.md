# Bitácora de cambios — Agrocarnes

Registro cronológico de todas las versiones del software. Cada entrada
corresponde a uno o más commits en GitHub (Backend-Agrocarnes y
Frontend-Agrocarnes), verificables con `git log`. Formato: fecha · versión ·
qué cambió · por qué · migraciones de base de datos.

Convención de versiones: `AAAA.MM.DD.n` (fecha de la entrega y número de
entrega del día).

---

## 2026.09.28.5 — Documentación para auditoría y respaldos

- Se crea la carpeta `docs/` con la documentación técnica y funcional
  completa (descripción general, arquitectura, modelo de datos, procesos,
  facturación electrónica, seguridad, operación) y esta bitácora.
- Se agrega `scripts/generar-pdf.sh` para producir el PDF de la documentación.
- Se agrega el **respaldo diario automático** de la base de datos
  (`scripts/respaldo-bd.sh`, cron 02:30, 30 días de retención) y su
  instalación en `setup-servidor.sh`.
- Regla adoptada: todo cambio funcional actualiza `docs/` y esta bitácora en
  el mismo commit.
- Sin migraciones.

## 2026.09.28.4 — Corrección: conservar HTTPS en despliegues

- `setup-servidor.sh` ya no sobrescribe la configuración de nginx cuando
  Certbot la ha modificado, y reinstala el certificado si existe pero nginx
  no lo usa. Motivo: un despliegue había dejado el sitio sin HTTPS.
- Sin migraciones.

## 2026.09.28.3 — Facturación electrónica vía Arco ERP

- Backend: cliente de la API de Arco (`src/dian/arco.js`), envío de facturas
  (`Factura/Insert`), consulta de número oficial y CUFE (`Factura/Get`),
  búsqueda/alta automática de clientes en Arco, job de reintentos cada 2
  minutos, endpoints de configuración y prueba de conexión por empresa,
  reenvío manual y actualización de estado por factura.
- Frontend: pantalla **Configuración** (solo admin), código Arco y % de
  impuesto en productos (creación y edición en línea), estados DIAN, CUFE,
  mensaje y botones de reintento en Ventas; dirección y ciudad en clientes.
- Motivo: emitir factura electrónica a la DIAN a través del proveedor
  tecnológico Arco, con el que cada empresa tiene su resolución.
- Migración `003_arco.sql`: `empresa.arco_config`; `producto.arco_producto_id`,
  `producto.impuesto_pct`; `tercero.arco_tercero_id`, `arco_cliente_id`,
  `ciudad_id`, `direccion`; `factura_venta.arco_factura_id`, `dian_mensaje`,
  `dian_intentos`, `dian_ultimo_intento`, `dian_fecha`.
- Estado: probado contra un simulador de la API de Arco; pendiente la
  primera factura real cuando se configuren las credenciales de Arco de
  Agrocarnes y del Restaurante.

## 2026.09.28.2 — Módulos operativos completos

- Backend: rutas de bodegas, terceros (clientes/proveedores) y recetas;
  listados con detalle de compras, traslados, producción y ventas;
  consecutivo interno de factura por empresa (AGC-, RST-, DMS-); costo
  unitario guardado en cada orden de producción; CORS tolerante.
- Frontend: módulos **Inventario** (existencias por bodega, kardex, alta de
  productos), **Compras** (líneas múltiples, alta de proveedor),
  **Traslados** (según existencia de origen), **Formulación** (fórmulas y
  producción con vista previa de consumo) y **Ventas** (líneas, cliente
  opcional, detalle de factura).
- `setup-servidor.sh` sincroniza con `origin/main` en lugar de `git pull`
  (evitaba actualizar por un `package-lock.json` local).
- Migración `002_bodegas_y_consecutivos.sql`: bodega "Principal" por
  empresa; `orden_produccion.costo_unitario`; índice único en `receta`;
  `empresa.prefijo_factura`, `ultimo_consecutivo`.
- Pruebas: flujo completo compra → fórmula → producción → traslado → venta
  verificado en navegador y por API; rechazo de ventas sin existencia.

## 2026.09.28.1 — Puesta en producción del sistema base

- Repositorios creados en la organización Ecocargapp: `Backend-Agrocarnes`
  y `Frontend-Agrocarnes`.
- Backend: API Express + PostgreSQL con modelo multiempresa, inventario con
  costo promedio ponderado (`registrarMovimiento`), compras, traslados,
  producción por receta, ventas y punto de integración DIAN; autenticación
  JWT; migraciones con registro (`schema_migrations`).
- Frontend: inicio de sesión y esqueleto de navegación.
- Infraestructura: instalación en el servidor EC2 existente, separada de
  AgroSoft (base de datos `agrocarnes`, proceso pm2 `agrocarnes-api` en el
  puerto 4001, nginx propio); dominios `agrocarnes.agrofranpabel.com` y
  `api-agrocarnes.agrofranpabel.com`; certificado HTTPS Let's Encrypt.
- Script de instalación/actualización idempotente `setup-servidor.sh`.
- Correcciones del mismo día: `ecosystem.config` renombrado a `.cjs` (el
  proyecto es ESM); `crear_admin.js` actualiza la clave si el usuario existe.
- Migración `001_init.sql`: modelo completo (empresa, usuario, tercero,
  producto, bodega, existencia, movimiento_inventario, traslado, receta,
  orden_produccion, compra, compra_item, factura_venta, factura_venta_item)
  y las tres empresas iniciales.

## 2026.09.27 — Diseño

- Documento de diseño del sistema (alcance, flujo entre empresas, módulos,
  modelo de datos, arquitectura, alternativas de facturación electrónica,
  plan por fases). Decisión: infraestructura propia separada de AgroSoft;
  facturación electrónica a través de un proveedor tecnológico en lugar de
  desarrollo propio ante la DIAN.

---

## Pendientes conocidos (no son cambios; se documentan para trazabilidad)

| Tema | Estado |
| --- | --- |
| Tratamiento tributario de los traslados Agrocarnes → Restaurante / D'Monsa (interno vs. venta intercompañía) | Por confirmar con el contador; el sistema soporta ambos |
| Notas crédito y anulación de facturas electrónicas | Por implementar (Arco: `NotaCredito/Insert`, `Factura/Anula`) |
| Bitácora de inicios de sesión y consultas | Por implementar |
| Administración de usuarios desde la aplicación | Por implementar |
| Copia de respaldos fuera del servidor (S3) | Por implementar |
| Cuenta de Arco del Restaurante y de D'Monsa | Por configurar |
| Carga inicial de productos y fórmulas desde las hojas de cálculo existentes | Por hacer |
