# Bitácora de cambios — Agrocarnes

Registro cronológico de todas las versiones del software. Cada entrada
corresponde a uno o más commits en GitHub (Backend-Agrocarnes y
Frontend-Agrocarnes), verificables con `git log`. Formato: fecha · versión ·
qué cambió · por qué · migraciones de base de datos.

Convención de versiones: `AAAA.MM.DD.n` (fecha de la entrega y número de
entrega del día).

---

## 2026.10.02.2 — Contabilidad automática (PUC), módulo de Gastos e Informes

- **Contabilidad automática** (migración `010_contabilidad.sql`,
  `src/contabilidad/`): plan de cuentas PUC, asientos generados desde cada
  documento (venta, nota crédito, compra, gasto, recibo, pago, traslado entre
  centros de costo, depreciación mensual). Se pueden reconstruir completos
  (`POST /informes/reconstruir`); los asientos manuales (aportes de capital)
  se conservan. Verificado: activo = pasivo + patrimonio por empresa y
  consolidado.
- **Gastos** (`/gastos`): separados de las compras de inventario; por
  categoría (nómina, honorarios, arriendo, servicios, publicidad, financieros…)
  con su cuenta 51/52/53, y **activos fijos** (cuentas 15xx) con depreciación
  en línea recta según la vida útil fiscal (construcciones 45 años, maquinaria
  y muebles 10, vehículos 10, cómputo 5). Entran a cuentas por pagar y a los
  pagos a proveedores.
- **IVA y retenciones**: compras y gastos con IVA por línea y retenciones
  automáticas por concepto (tabla del Decreto 572 de 2025, vigente desde el
  1/07/2026, UVT 2026 = $52.374), corregibles a mano; no se retiene a
  autorretenedores ni al régimen simple. Los recibos de caja registran las
  retenciones que nos practican los clientes (anticipo de impuestos).
- **Informes** (`/informes`): venta diaria, estado de resultados (utilidad
  bruta, EBITDA, utilidad operacional, utilidad antes de impuestos), balance
  general, IVA e INC a pagar, retenciones a pagar (formulario 350) frente a las
  que nos practicaron, libro diario exportable a Excel; por empresa o
  consolidado. Aportes de capital desde la misma pantalla.

## 2026.10.02.1 — Terceros con los campos de la plantilla contable

- Backend (migración `008_terceros_completos.sql`): el tercero ahora tiene
  los 28 campos de la plantilla de importación de terceros
  (Template-7580.xlsx): tipo de persona, nombres y apellidos o razón social,
  nombre comercial, dirección, ciudad DANE, teléfono, correo, autorretenedor,
  regímenes de renta/IVA/ICA, límites de retención, tarifa de rete IVA,
  cuenta bancaria, id exterior, estado y código de país. `POST /terceros`
  valida con las reglas de la plantilla (natural: primer nombre y apellido;
  jurídica: razón social; dirección ≥ 8 caracteres; ciudad de 5 dígitos;
  teléfono; regímenes según el tipo de persona; documento sin DV y sin
  repetir). Nuevo `PUT /terceros/:id`.
- Factus: el adquiriente usa el tipo de persona, nombre comercial y régimen
  de IVA del tercero; más tipos de documento (RC, TE, DE, exógena).
- Frontend: formulario único de tercero en **Ventas** (clientes) y
  **Compras** (proveedores), con la sección tributaria y bancaria plegable,
  y botón para descargar todos los terceros en el formato de la plantilla.

## 2026.09.30.2 — Venta interna entre centros de costo de la misma razón social

- Backend (migración `007_venta_interna.sql`): `factura_venta.venta_interna`.
  Una venta marcada como interna (ej. Carnicería → Restaurante, ambos de
  Unión Avícola Agropollo) descuenta inventario y genera cartera como cualquier
  venta, pero queda en `estado_dian = 'no_aplica'` y nunca se envía a la DIAN
  (una empresa no puede facturarse electrónicamente a su propio NIT).
- Frontend: casilla "Venta interna" en **Ventas**.

## 2026.09.30.1 — Menú del restaurante, INC y ajustes para facturar en producción con Factus

- Backend (migración `006_precio_venta_y_restaurante.sql`): `producto.precio_venta`
  (precio sugerido, con impuesto), `producto.maneja_inventario` (los platos del
  menú y servicios se facturan sin existencias ni movimiento de kardex) y
  `producto.tipo_impuesto` (`IVA` | `INC`, impuesto nacional al consumo, que se
  envía a Factus con el código de tributo 04).
- Backend: ventas sin cliente se facturan al consumidor final estándar de la
  DIAN (222222222222) aunque la empresa no tenga `cliente_default`; el medio
  de pago de contado se toma del recibo de caja (efectivo = 10, transferencia
  = 47, tarjeta = 48) en lugar del 42 (consignación) fijo.
- Corrección: una factura emitida por Factus (con CUFE o enviada) no se podía
  reconocer como electrónica — se podía anular localmente y sus notas crédito
  quedaban en `no_aplica` sin enviarse. Ahora ambas reglas cubren Arco y Factus.
- Frontend: en **Inventario**, precio de venta, tipo de impuesto y la marca de
  inventario por producto; en **Ventas**, los platos del menú aparecen en el
  punto de venta de su empresa aunque no tengan existencias y el precio se
  prellena con el precio de venta.

## 2026.09.28.8 — Factus como nuevo proveedor de facturación electrónica

- Backend: se agrega **Factus** (`developers.factus.com.co`) en paralelo a
  Arco, sin quitarlo: cada empresa elige su proveedor activo
  (`empresa.proveedor_dian`, `arco` | `factus`). `src/dian/factus.js`
  (cliente OAuth2), `src/dian/facturas-factus.js` y `src/dian/notas-factus.js`
  (envío de facturas y notas crédito). `src/dian/cliente.js` y `notas.js`
  ahora despachan a Arco o a Factus según la empresa; el job de reintentos
  cubre ambos proveedores.
- Backend: `GET/PUT/DELETE /empresas/:id/factus` (configuración) y
  `POST /empresas/:id/factus/probar` (prueba credenciales y lista los rangos
  de numeración disponibles); `PUT /empresas/:id/proveedor-dian` para elegir
  el proveedor activo.
- Frontend: pantalla **Configuración** ahora tiene un selector de proveedor
  por empresa y el formulario de cuenta de Factus (credenciales, entorno
  sandbox/producción, rangos de numeración, botón "Probar conexión"); en
  **Inventario**, columna editable para el código de unidad de medida de
  Factus por producto (opcional; si está vacío se infiere de la unidad).
- Migración `005_factus.sql`: `empresa.factus_config`, `empresa.proveedor_dian`,
  `producto.factus_unidad_medida_code`, `producto.factus_estandar_code`.
- Probado contra el **sandbox real de Factus** con las credenciales de
  prueba que dio Factus: login OAuth2, `GET /v2/numbering-ranges`, creación
  de una factura con CUFE real devuelto de inmediato, y una nota crédito de
  anulación referenciándola correctamente. También se verificó localmente
  (sin red, con las respuestas reales capturadas) que el payload armado por
  `cliente.js`/`notas.js` es correcto y que el estado queda bien guardado en
  la base de datos. Detalle y pendientes antes de facturar de verdad con
  Factus en docs/05.

## 2026.09.28.7 — Pantallas de cartera y notas crédito; informes a Excel

- Frontend: pantalla **Cartera** (por cobrar / por pagar) con resumen,
  antigüedad de saldos por cliente/proveedor, detalle de documentos y
  registro de recibos de caja y pagos a proveedores (aplicables a una o
  varias facturas/compras a la vez).
- Frontend: pantalla **Notas crédito**, accesible también desde el detalle
  de una factura en Ventas ("Nota crédito / Anular"): selecciona la
  factura, marca los productos y cantidades a devolver con su razón, o
  anula la factura completa con un solo botón.
- Frontend: Ventas y Compras ahora piden la forma de pago (contado/crédito)
  al registrar el documento, con medio de pago o plazo según corresponda;
  antes siempre se enviaban como "contado" sin que la pantalla lo pidiera.
- Frontend: **informe de venta diaria** (Ventas) y **detalle de cartera**
  (Cartera) descargables a Excel (.xlsx), con fecha de factura, fecha de
  vencimiento, forma y medio de pago. Se generan en el navegador con la
  librería `xlsx` (SheetJS) empaquetada localmente en `js/vendor/` — no se
  carga desde un CDN externo, para no depender de la red de cada cliente.
- Backend: `GET /ventas/reporte-diario` (ventas del día con forma y medio de
  pago) y `GET /cartera/clientes/documentos` / `GET /cartera/proveedores/documentos`
  (todos los documentos con saldo, con fecha de factura y vencimiento) para
  alimentar esos informes. `GET /ventas/:id` ahora también devuelve
  `producto_id` en cada ítem (lo necesita la pantalla de notas crédito).
- Corrección: un `[hidden]` en un `<label>` no ocultaba nada porque la regla
  propia `label { display: flex }` le ganaba a `[hidden]` del navegador (el
  origen "author" siempre gana sobre el "user-agent", sin importar
  especificidad) — afectaba a los campos que se muestran u ocultan según la
  forma de pago elegida. Se agregó `[hidden] { display: none !important; }`
  una sola vez en `styles.css`.
- Pruebas: flujo de punta a punta con un navegador real (Playwright, sin
  interfaz) contra la API local — venta de contado y a crédito, alternar
  forma de pago, descarga y verificación del contenido de los dos informes
  Excel, recibo y pago parciales con la validación de saldo, anulación de
  factura por nota crédito, y las notas crédito quedando en `no_aplica`
  cuando la factura no es electrónica.

## 2026.09.28.6 — Cartera propia y notas crédito

- Backend: cartera de cuentas por cobrar y por pagar propia del sistema (no
  depende de Arco ni del reporte del contador): recibos de caja (cobro de
  una o varias facturas de un cliente) y pagos a proveedores (una o varias
  compras), con antigüedad de saldos (por vencer, 1-30, 31-60, 61-90, más de
  90 días) y resumen por empresa (`src/routes/cartera.js`).
- Backend: notas crédito sobre facturas de venta — devolución parcial,
  anulación (reingresa todo el inventario y anula la factura), rebaja o
  descuento, ajuste de precio, descuento pronto pago y por volumen; valida
  que no se devuelva más de lo facturado descontando notas anteriores
  (`src/routes/notas-credito.js`). Envío a Arco en segundo plano cuando la
  factura original fue emitida electrónicamente (`src/dian/notas.js`, mismo
  patrón de reintentos que las facturas); si no lo fue, el efecto es solo
  local (`estado_dian = 'no_aplica'`).
- Ventas y compras ahora admiten `forma_pago` contado/crédito con plazo o
  fecha de vencimiento; de contado se cobra/paga automáticamente al
  registrar el documento.
- Corrección: el envío de `anulacion: true` sin `razon` explícita en
  `POST /notas-credito` fallaba la validación antes de inferir `razon = 2`
  (se movió la inferencia antes de validar).
- Migración `004_cartera_y_notas_credito.sql`: `factura_venta.forma_pago`,
  `fecha_vencimiento`, `saldo`, `estado`, `anulada_en`, `anulada_por`,
  `motivo_anulacion`, `creado_por`; `compra.forma_pago`, `fecha_vencimiento`,
  `saldo`, `creado_por`; tablas `recibo_caja`, `recibo_caja_aplicacion`,
  `pago_proveedor`, `pago_proveedor_aplicacion`, `nota_credito`,
  `nota_credito_item`; `empresa.ultimo_recibo`, `ultimo_pago`,
  `ultimo_nota_credito`; nuevos tipos de movimiento de inventario
  `devolucion_venta` y `anulacion_venta`.
- Pruebas: flujo completo probado de punta a punta contra una base de datos
  local (compra a crédito → pago parcial → saldo correcto; venta a crédito →
  recibo parcial → saldo correcto; nota crédito con devolución parcial →
  reingreso de inventario al costo original y reducción del saldo; nota
  crédito de anulación total → saldo en cero, factura anulada, inventario
  reingresado; rechazo de recibos/pagos que superan el saldo disponible).
  Pendiente: validar los campos de NotaCredito/Insert contra Arco antes de
  la primera nota crédito real (ver README y docs/05).
- docs/03, docs/04 y docs/05 actualizados con el modelo de datos, el proceso
  de cartera y notas crédito, y el detalle de la integración con Arco.

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
| Campos exactos de `NotaCredito/Insert` y `NotaCredito/Get` de Arco | Implementado con la misma convención que `Factura/Insert`; por confirmar con Arco y probar contra el simulador antes de la primera nota crédito real |
| Bitácora de inicios de sesión y consultas | Por implementar |
| Administración de usuarios desde la aplicación | Por implementar |
| Copia de respaldos fuera del servidor (S3) | Por implementar |
| Cuenta de Arco del Restaurante y de D'Monsa | Por configurar |
| Carga inicial de productos y fórmulas desde las hojas de cálculo existentes | Por hacer |
