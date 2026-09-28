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

## 4.5 Consulta de inventario y kardex

Pantalla **Inventario**: existencias por bodega (cantidad, costo promedio,
valor) y, al seleccionar un producto, su kardex: cada movimiento con fecha,
tipo, cantidad (+/−) y costo. El valor del inventario mostrado es
Σ cantidad × costo_promedio.

## 4.6 Correcciones

No se editan ni eliminan documentos ya registrados. Una compra mal digitada
se corrige con una compra de ajuste; un traslado en sentido contrario
devuelve el producto; una venta se corregirá con nota crédito cuando ese
módulo esté disponible. Mientras tanto, cualquier ajuste manual que fuera
indispensable se hace en la base de datos por el administrador y se
documenta en el CHANGELOG con fecha, motivo y registros afectados.
