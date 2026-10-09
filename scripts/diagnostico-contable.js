// Diagnóstico de solo lectura: documentos vs asientos, ventas por día e inventario.
import { pool } from '../src/db/pool.js';
const q = async (t, s, p = []) => { const { rows } = await pool.query(s, p); console.log(`\n== ${t}`); console.table(rows); };
await q('Facturas por estado y día', `select (fecha at time zone 'America/Bogota')::date dia, estado, venta_interna, estado_dian, count(*)::int n, sum(total) total from factura_venta group by 1,2,3,4 order by 1`);
await q('Documentos vs asientos', `
  select 'factura_venta' origen, (select count(*) from factura_venta)::int docs, (select count(*) from asiento where origen='factura_venta')::int asientos
  union all select 'compra', (select count(*) from compra)::int, (select count(*) from asiento where origen='compra')::int
  union all select 'recibo_caja', (select count(*) from recibo_caja)::int, (select count(*) from asiento where origen='recibo_caja')::int
  union all select 'pago_proveedor', (select count(*) from pago_proveedor)::int, (select count(*) from asiento where origen='pago_proveedor')::int
  union all select 'traslado', (select count(*) from traslado)::int, (select count(*) from asiento where origen='traslado')::int
  union all select 'nota_credito', (select count(*) from nota_credito)::int, (select count(*) from asiento where origen='nota_credito')::int
  union all select 'manual', 0, (select count(*) from asiento where origen='manual')::int`);
await q('Asientos por mes y origen', `select to_char(fecha,'YYYY-MM') mes, origen, count(*)::int n from asiento group by 1,2 order by 1,2`);
await q('Compras', `select c.fecha, e.nombre empresa, c.numero_factura_proveedor, c.estado, c.clase, c.subtotal, c.iva, c.total, c.saldo,
  (select sum(cantidad*costo_unitario) from compra_item i where i.compra_id=c.id) items_valor,
  (select sum(cantidad*costo_unitario) from movimiento_inventario m where m.referencia_tipo='compra' and m.referencia_id=c.id and m.tipo='compra') mov_entrada
  from compra c join empresa e on e.id=c.empresa_id order by c.fecha`);
await q('Movimientos de inventario por tipo y empresa', `select e.nombre empresa, m.tipo, count(*)::int n, round(sum(m.cantidad),2) cantidad, round(sum(m.cantidad*m.costo_unitario)) valor
  from movimiento_inventario m join bodega b on b.id=m.bodega_id join empresa e on e.id=b.empresa_id group by 1,2 order by 1,2`);
await q('Existencias valorizadas por empresa', `select e.nombre empresa, count(*)::int productos, round(sum(x.cantidad),2) cantidad, round(sum(x.cantidad*x.costo_promedio)) valor
  from existencia x join bodega b on b.id=x.bodega_id join empresa e on e.id=b.empresa_id group by 1`);
await pool.end();
