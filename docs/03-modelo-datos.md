# 03 · Modelo de datos

Base de datos PostgreSQL `agrocarnes`. Todas las claves primarias son UUID
generados por la base de datos; todos los registros llevan `creado_en`
(fecha y hora del servidor, zona UTC). Los importes van en `numeric(14,2)` y
las cantidades en `numeric(14,3)` (gramos de precisión en kilogramos).

## Diagrama de relaciones

```
empresa ──< bodega ──< existencia >── producto >── empresa
   │                        │            │
   │                  movimiento_inventario (tabla central)
   │                        │
   ├──< compra ──< compra_item ── producto / bodega
   ├──< orden_produccion ── producto (terminado) / bodega
   │         receta: producto_terminado ──< producto_insumo
   ├──< factura_venta ──< factura_venta_item ── producto
   │         │
   │      tercero (cliente)                 traslado: bodega_origen → bodega_destino
   └── usuario                              tercero (proveedor) ── compra
```

## Tablas

### empresa
| Campo | Tipo | Descripción |
| --- | --- | --- |
| id | uuid | PK |
| nombre | text | Agrocarnes · Restaurante · D'Monsa Alimentos |
| nit | text | NIT (se diligencia al configurar) |
| es_facturador_dian | boolean | Emite factura electrónica |
| prefijo_factura | text | Prefijo del consecutivo interno (AGC, RST, DMS) |
| ultimo_consecutivo | integer | Último número interno asignado |
| arco_config | jsonb | Credenciales y parámetros de Arco (ver doc 05) |

### usuario
| Campo | Tipo | Descripción |
| --- | --- | --- |
| id, empresa_id | uuid | |
| nombre, email (único) | text | |
| password_hash | text | bcrypt, 10 rondas; la contraseña nunca se almacena en claro |
| rol | text | `admin` · `operador` |
| activo | boolean | Bloqueo de acceso sin borrar el usuario |

### tercero
Clientes y proveedores. `tipo` ∈ cliente · proveedor · ambos. Campos:
nombre, tipo_documento (CC, NIT, CE…), numero_documento, email, telefono,
direccion, ciudad_id (código DANE), `arco_tercero_id`, `arco_cliente_id`
(identificadores del mismo tercero dentro de Arco).

### producto
| Campo | Tipo | Descripción |
| --- | --- | --- |
| empresa_id | uuid | Empresa dueña del producto |
| nombre | text | Único por empresa |
| tipo | text | materia_prima · intermedio · terminado |
| unidad_medida | text | kg, un, lb, g, l |
| arco_producto_id | text | Código del producto en Arco (obligatorio para facturarlo) |
| impuesto_pct | numeric(5,2) | % de impuesto incluido en el precio de venta (IVA o impoconsumo) |

### bodega
`empresa_id`, `nombre`. Cada empresa tiene al menos la bodega "Principal".

### existencia
Saldo vivo por (bodega, producto): `cantidad`, `costo_promedio`,
`actualizado_en`. Se recalcula en cada movimiento; nunca se edita a mano.

### movimiento_inventario — tabla central de auditoría
| Campo | Descripción |
| --- | --- |
| tipo | compra · porcionado_entrada · porcionado_salida · traslado_salida · traslado_entrada · produccion_consumo · produccion_entrada · venta · devolucion_venta · anulacion_venta |
| producto_id, bodega_id | Qué y dónde |
| cantidad | Siempre positiva; el tipo indica si entra o sale |
| costo_unitario | Costo al que se valoró el movimiento |
| referencia_tipo, referencia_id | Documento origen: compra · traslado · orden_produccion · factura_venta |
| creado_por | Usuario que registró el documento |
| creado_en | Fecha y hora |

Con esta tabla se reconstruye el kardex de cualquier producto en cualquier
bodega y se verifica que `existencia` = Σ entradas − Σ salidas.

### compra / compra_item
Cabecera: empresa_id, proveedor_id, numero_factura_proveedor, fecha, total.
Detalle: producto_id, bodega_id, cantidad, costo_unitario. Cada ítem genera
un movimiento tipo `compra`.

### traslado
producto_id, bodega_origen_id, bodega_destino_id, cantidad, costo_unitario
(el promedio de origen en ese momento), `es_venta_intercompania`,
`factura_venta_id` (si el traslado se factura entre compañías). Genera dos
movimientos: `traslado_salida` y `traslado_entrada`.

### receta
Fórmula: (producto_terminado_id, producto_insumo_id) única →
cantidad_por_unidad. Es la cantidad de insumo necesaria para producir **una
unidad** del terminado.

### orden_produccion
empresa_id, producto_terminado_id, cantidad_producida, bodega_id,
costo_unitario (calculado), creado_por. Genera un movimiento
`produccion_consumo` por insumo y uno `produccion_entrada` por el terminado.

### factura_venta / factura_venta_item
| Campo | Descripción |
| --- | --- |
| empresa_id, cliente_id | Emisor y adquiriente (nulo = consumidor final) |
| consecutivo | Número interno al crear; se reemplaza por el número oficial de Arco cuando la factura se emite |
| fecha, total | |
| forma_pago | contado · credito |
| fecha_vencimiento | Solo si es a crédito |
| saldo | Lo que falta por cobrar; solo lo modifican `/cartera/recibos` y las notas crédito |
| estado | vigente · anulada |
| anulada_en, anulada_por, motivo_anulacion | Trazabilidad de la anulación (directa o por nota crédito razón 2) |
| estado_dian | pendiente · sin_configurar · enviada · aceptada · error · rechazada |
| arco_factura_id | Identificador de la factura dentro de Arco |
| cufe | Código Único de Factura Electrónica devuelto por Arco/DIAN |
| xml_url, pdf_url | Enlace a la representación publicada por Arco |
| dian_mensaje, dian_intentos, dian_ultimo_intento, dian_fecha | Trazabilidad del envío |

Detalle: producto_id, cantidad, precio_unitario. Cada ítem genera un
movimiento `venta` valorado al costo promedio vigente (lo que permite
calcular el margen).

### compra (cartera)
Igual mecánica que `factura_venta`: `forma_pago` (contado · credito),
`fecha_vencimiento`, `saldo` (lo que falta por pagar; solo lo modifica
`/cartera/pagos`).

### recibo_caja / recibo_caja_aplicacion — cartera de clientes (CxC)
Un recibo de caja es el cobro de una o varias facturas de un mismo cliente.
Cabecera (`recibo_caja`): empresa_id, tercero_id (nulo si es consumidor
final), consecutivo (por empresa, `empresa.ultimo_recibo`), fecha, medio_pago,
total, notas. Detalle (`recibo_caja_aplicacion`): factura_venta_id, valor —
puede haber varias aplicaciones por recibo (un pago cubre varias facturas) y
varios recibos por factura (pagos parciales). Cada aplicación resta su valor
de `factura_venta.saldo`; nunca se permite aplicar más del saldo disponible.

### pago_proveedor / pago_proveedor_aplicacion — cartera de proveedores (CxP)
Simétrico al recibo de caja pero para compras: `pago_proveedor` (consecutivo
en `empresa.ultimo_pago`) y `pago_proveedor_aplicacion` (compra_id, valor),
que resta de `compra.saldo`.

### nota_credito / nota_credito_item
Nota crédito sobre una factura de venta. Cabecera: empresa_id,
factura_venta_id, consecutivo (`NC-<prefijo>-<consecutivo>`, en
`empresa.ultimo_nota_credito`), razon (código DIAN: 1 devolución parcial · 2
anulación · 3 rebaja/descuento · 4 ajuste de precio · 5 dcto pronto pago · 6
dcto volumen), reingresa_inventario, bodega_id (si reingresa), total, estado
de envío a Arco (`estado_dian`: mismos estados que la factura, más
`no_aplica` cuando la factura original no es electrónica), cufe, pdf_url.
Detalle (`nota_credito_item`): producto_id, cantidad, precio_unitario. No se
puede devolver más cantidad que la facturada, descontando notas anteriores
sobre la misma factura. Si `reingresa_inventario`, genera un movimiento
`devolucion_venta` (razones 1,3-6) o `anulacion_venta` (razón 2) por ítem, al
costo con el que salió originalmente la venta.

### schema_migrations
Registro de qué migraciones se aplicaron y cuándo. Migraciones a la fecha:
`001_init.sql` (modelo base), `002_bodegas_y_consecutivos.sql` (bodega
principal por empresa, consecutivos, costo en órdenes de producción),
`003_arco.sql` (integración con Arco), `004_cartera_y_notas_credito.sql`
(cuentas por cobrar y por pagar, notas crédito y anulación de facturas).

## Reglas de integridad implementadas

- No se permite una salida mayor a la existencia disponible (la transacción
  se revierte con el mensaje "No hay suficiente existencia para esta salida").
- Un producto no puede ser insumo de sí mismo.
- Un traslado no puede tener la misma bodega de origen y destino.
- Un usuario inactivo no puede iniciar sesión.
- Las claves foráneas impiden borrar productos, bodegas o terceros que
  tengan movimientos.
