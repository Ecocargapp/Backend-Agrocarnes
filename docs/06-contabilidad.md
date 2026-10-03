# 06 · Contabilidad, gastos e informes

## Cómo funciona

Cada documento del sistema genera su asiento contable con cuentas del PUC
(`src/contabilidad/contabilizar.js`). Los asientos son **derivados**: se
pueden borrar y volver a generar desde los documentos en cualquier momento
(Informes → *Reconstruir contabilidad*, `POST /informes/reconstruir`). Los
asientos manuales (aportes de capital) no se tocan en una reconstrucción.

| Documento | Débito | Crédito |
| --- | --- | --- |
| Venta | 1305 clientes · 6135 costo de ventas | 4135 ventas · 240801 IVA · 249595 INC · 1435 inventario |
| Nota crédito | 4175 devoluciones · 240801/249595 · 1435 (si reingresa) | 1305 · 6135 |
| Compra de inventario | 1435 · 240802 IVA descontable | 2205 proveedores · 2365/2367/2368 retenciones |
| Gasto | 51xx/52xx/53xx según categoría · 240802 | 2335 costos y gastos por pagar · retenciones |
| Activo fijo (desde Gastos) | 15xx al costo + IVA | 2335 · retenciones |
| Recibo de caja | 1105 caja (efectivo) / 1110 bancos · 1355 retenciones que nos practicaron | 1305 |
| Pago a proveedor | 2205 / 2335 | 1105 / 1110 |
| Traslado entre empresas | destino 1435 · origen 2895 | origen 1435 · destino 2895 |
| Depreciación (mensual) | 5160 | 1592 |
| Aporte de capital (manual) | 1110 / 1105 | 3115 |

Venta anulada sin nota crédito: se elimina su asiento (la venta no existió).
Venta anulada con nota crédito: se conserva y la nota la reversa.

## Gastos y activos fijos

Pantalla **Gastos**. Se guardan en `compra` con `clase = 'gasto'` (así entran
a cuentas por pagar y a pagos a proveedores) y sus renglones en `gasto_item`.
Categorías y cuentas en `src/contabilidad/catalogos.js`. Un renglón de activo
fijo crea un registro en `activo_fijo`, que se deprecia en línea recta desde
el mes siguiente a la compra (vida útil fiscal, art. 137 E.T.). El IVA de un
activo fijo se suma a su costo.

## Retenciones

Tabla `concepto_retencion` (Decreto 572 de 2025, vigente desde el 1/07/2026;
UVT 2026 = $52.374, en `empresa.config_tributaria`). Se calcula retefuente si
la base sin IVA supera la base mínima del concepto; no se retiene a
autorretenedores ni a proveedores del régimen simple. ReteIVA (15% del IVA)
solo si la empresa se marca como agente de retención de IVA; reteICA según la
tarifa por mil del municipio. Todo se puede corregir en el documento.

Retenciones que nos practican: se registran en el recibo de caja y quedan en
1355 como anticipo (retefuente → renta, reteIVA → declaración de IVA,
reteICA → ICA).

## Informes

Venta diaria · Estado de resultados (ventas netas, costo, utilidad bruta,
gastos de administración y ventas, EBITDA, depreciación, utilidad
operacional, no operacionales, utilidad antes de impuestos) · Balance general
(con verificación activo = pasivo + patrimonio) · IVA e INC a pagar ·
Retenciones a pagar (formulario 350) · Libro diario (Excel para el contador).
Por empresa (centro de costo) o consolidado.

## Pendientes conocidos

- Platos del restaurante (sin inventario): no generan costo de ventas; la
  carne comprada para el restaurante queda en inventario hasta que se
  implemente el consumo por receta o una salida de inventario por consumo.
- Autorretención especial de renta (Decreto 572: tarifas por actividad
  CIIU): no se calcula; definir con el contador.
- Nómina electrónica: los pagos de nómina se registran como gasto en la
  categoría "Nómina y prestaciones".
- Cierre del ejercicio (traslado del resultado a utilidades acumuladas):
  pendiente para el primer cierre anual.
