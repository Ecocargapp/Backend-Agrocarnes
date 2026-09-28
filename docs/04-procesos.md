# 04 · Procesos de negocio

Cada proceso se describe con: quién lo ejecuta, qué pantalla usa, qué queda
registrado y cómo afecta el inventario y el costo. Todos los procesos quedan
en `movimiento_inventario` con usuario, fecha y documento origen.

## 4.1 Compra a proveedor

**Caso típico:** Agro Franpabel vende cerdo despostado a Agrocarnes (o a
D'Monsa) y entrega su factura.

1. Pantalla **Compras**. El operador elige la empresa que compra, la bodega
   que recibe, el proveedor (o lo crea) y digita el número de la factura del
   proveedor, la fecha y las líneas (producto, cantidad, costo unitario).
2. El sistema guarda `compra` + `compra_item` y, por cada línea, un
   movimiento `compra` en la bodega indicada.
3. **Efecto en inventario:** entra la cantidad; el costo promedio se
   recalcula:

   costo_promedio_nuevo = (stock_anterior × costo_anterior + cantidad × costo_compra) ÷ (stock_anterior + cantidad)

4. **Soporte:** la factura física/electrónica del proveedor, cuyo número queda
   en `numero_factura_proveedor`.

## 4.2 Porcionado (despiece) y producción por fórmula

El porcionado de la canal y la producción de embutidos y productos de
panadería se registran con el mismo mecanismo: una **fórmula** que dice
cuánto insumo se necesita por unidad de producto terminado.

**Ejemplos de fórmulas:**
- Lomo de cerdo (kg) = 1,25 kg de cerdo despostado (rendimiento 80 %).
- Carne para embutido (kg) = 1,00 kg de cerdo despostado.
- Salchicha (kg) = 0,90 kg de carne para embutido + condimentos.

1. Pantalla **Formulación → Fórmulas**: se define o ajusta la fórmula del
   producto. Queda en `receta`.
2. Pantalla **Formulación → Producir**: el operador indica producto, bodega
   y cantidad producida. El sistema muestra antes de confirmar cuánto insumo
   va a consumir.
3. Se guarda `orden_produccion`; por cada insumo un movimiento
   `produccion_consumo` (cantidad = cantidad_por_unidad × cantidad producida,
   valorado al costo promedio del insumo) y un movimiento
   `produccion_entrada` del terminado.
4. **Costo del terminado** = Σ (insumo consumido × su costo promedio) ÷
   cantidad producida. Queda en `orden_produccion.costo_unitario` y entra al
   promedio del producto terminado.

La merma queda implícita en la fórmula (rendimiento). Si el rendimiento real
difiere, se ajusta la fórmula; el historial de órdenes conserva el costo con
el que se produjo cada lote.

## 4.3 Traslado entre empresas

**Casos:** Agrocarnes → Restaurante (cortes porcionados) y Agrocarnes →
D'Monsa (carne para embutidos).

1. Pantalla **Traslados**: bodega de origen, producto (solo aparecen los que
   tienen existencia allí), bodega de destino y cantidad.
2. Se guarda `traslado` con el costo promedio de origen en ese momento, y dos
   movimientos: `traslado_salida` en origen y `traslado_entrada` en destino,
   ambos al mismo costo.
3. **Efecto:** la existencia baja en una empresa y sube en la otra **al
   costo**, sin precio de venta y sin factura. Así el producto se factura una
   sola vez: cuando la empresa destino lo vende al cliente final.
4. El campo `es_venta_intercompania` permite marcar el traslado como venta
   entre compañías y asociarle una factura, si el tratamiento tributario
   definido con el contador así lo requiere. **A la fecha los traslados se
   registran como movimiento interno sin factura; este punto está pendiente
   de confirmación con el contador** (ver CHANGELOG).

## 4.4 Venta al cliente final

**Casos:** mostrador de Agrocarnes; consumo en el Restaurante.

1. Pantalla **Ventas**: punto de venta (empresa/bodega), cliente (opcional;
   sin cliente = consumidor final) y líneas (producto con existencia,
   cantidad, precio unitario).
2. En una transacción se guarda `factura_venta` (con consecutivo interno
   provisional), `factura_venta_item` y un movimiento `venta` por línea,
   valorado al costo promedio (para calcular margen). Si algún producto no
   tiene existencia suficiente, la venta completa se rechaza.
3. Inmediatamente después, y **sin bloquear la venta**, el sistema envía la
   factura al proveedor de facturación electrónica (doc 05). Cuando Arco la
   emite, el consecutivo provisional se reemplaza por el **número oficial de
   la factura electrónica** (prefijo y número de la resolución de la empresa)
   y se guarda el CUFE.
4. El estado de cada factura frente a la DIAN es visible en la lista de
   ventas; el detalle muestra CUFE, mensaje y permite reintentar.

## 4.4bis Cartera (cuentas por cobrar y por pagar)

Toda venta y toda compra nace con `forma_pago` contado o crédito. De contado
se cobra/paga de inmediato (recibo o pago automático por el mismo valor); a
crédito queda con `saldo` pendiente y una `fecha_vencimiento` (plazo en días
o fecha explícita).

1. Pantalla **Cartera → Por cobrar**: un resumen por cliente con antigüedad
   de saldos (por vencer, 1-30, 31-60, 61-90, más de 90 días) y, al entrar a
   un cliente, el detalle de sus facturas con saldo. El botón **Recibo de
   caja** registra un cobro (efectivo, transferencia, tarjeta u otro) que se
   puede aplicar a una o varias facturas del mismo cliente en un solo
   movimiento; no se permite aplicar más del saldo de cada factura.
2. Pantalla **Cartera → Por pagar**: lo mismo para proveedores. El botón
   **Pago a proveedor** aplica a una o varias compras.
3. El saldo de cada factura/compra vive únicamente en `factura_venta.saldo` /
   `compra.saldo` y solo lo modifican estos dos flujos (y las notas crédito,
   4.4ter). Nunca se edita a mano.
4. Pantalla **Cartera → Resumen**: total por cobrar y por pagar, y cuánto de
   eso está vencido, por empresa.

## 4.4ter Notas crédito y anulación de facturas

Corrige una factura de venta ya registrada sin borrar ni editar el
documento original (ver 4.6). Pantalla **Ventas → detalle de factura → Nota
crédito**, con una razón (código DIAN):

| Razón | Efecto en inventario | Efecto en cartera |
| --- | --- | --- |
| 1 · Devolución parcial | Reingresa lo devuelto (opcional) | Reduce el saldo por cobrar en el valor de la nota |
| 2 · Anulación de factura | Reingresa todo lo vendido | Salda la factura y la deja `anulada` |
| 3 · Rebaja o descuento | No mueve inventario | Reduce el saldo por cobrar |
| 4 · Ajuste de precio | No mueve inventario | Reduce el saldo por cobrar |
| 5 · Descuento pronto pago | No mueve inventario | Reduce el saldo por cobrar |
| 6 · Descuento por volumen | No mueve inventario | Reduce el saldo por cobrar |

No se puede devolver o descontar más de lo facturado (se valida contra las
notas ya emitidas sobre la misma factura). Si la factura ya tenía cobros
aplicados y se anula, el sistema informa el saldo a favor del cliente en
lugar de aplicarlo automáticamente. Cuando la factura fue emitida
electrónicamente, la nota crédito se envía a Arco en segundo plano (doc 05);
si no lo fue, el efecto es solo local.

Anular una factura **antes** de emitirla electrónicamente (`arco_factura_id`
nulo) usa en cambio `POST /ventas/:id/anular`, que revierte directamente sin
generar una nota crédito formal — solo aplica si no tiene cobros aplicados a
crédito.

## 4.5 Consulta de inventario y kardex

Pantalla **Inventario**: existencias por bodega (cantidad, costo promedio,
valor) y, al seleccionar un producto, su kardex: cada movimiento con fecha,
tipo, cantidad (+/−) y costo. El valor del inventario mostrado es
Σ cantidad × costo_promedio.

## 4.6 Correcciones

No se editan ni eliminan documentos ya registrados. Una compra mal digitada
se corrige con una compra de ajuste; un traslado en sentido contrario
devuelve el producto; una venta se corrige con una nota crédito (4.4ter) o,
si aún no ha sido emitida electrónicamente y no tiene cobros a crédito
aplicados, con `POST /ventas/:id/anular`. Cualquier ajuste manual que fuera
indispensable fuera de estos flujos se hace en la base de datos por el
administrador y se documenta en el CHANGELOG con fecha, motivo y registros
afectados.
