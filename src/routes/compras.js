import { Router } from 'express';
import { pool } from '../db/pool.js';
import { registrarMovimiento } from '../db/inventario.js';
import { calcularRetenciones } from '../contabilidad/retenciones.js';
import { contabilizar } from '../contabilidad/contabilizar.js';

export const router = Router();

// Registra una compra a un proveedor externo (ej. Agro Franpabel -> Agrocarnes
// o Agro Franpabel -> D'Monsa): entra el insumo al costo facturado.
// body: { empresa_id, proveedor_id, numero_factura_proveedor, fecha, items: [{producto_id, bodega_id, cantidad, costo_unitario}] }
router.post('/', async (req, res) => {
  const { empresa_id, proveedor_id, numero_factura_proveedor, fecha, items, forma_pago = 'contado', dias_plazo, fecha_vencimiento, medio_pago } = req.body;
  if (!['contado', 'credito'].includes(forma_pago)) return res.status(400).json({ error: 'forma_pago debe ser contado o credito' });
  if (!empresa_id || !proveedor_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Faltan empresa_id, proveedor_id o items' });
  }

  // Base, IVA descontable y retenciones (calculadas por concepto si no vienen).
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const subtotal = r2(items.reduce((acc, it) => acc + r2(Number(it.cantidad) * Number(it.costo_unitario)), 0));
  const iva = r2(items.reduce((acc, it) => acc + r2(Number(it.cantidad) * Number(it.costo_unitario) * (Number(it.iva_pct) || 0) / 100), 0));
  const concepto = req.body.concepto_retencion || 'ninguna';
  const calc = await calcularRetenciones({ empresa_id, proveedor_id, concepto, base: subtotal, iva });
  const dado = (v, c) => (v === undefined || v === '' || v === null ? c : r2(v));
  const ret = { f: dado(req.body.retefuente, calc.retefuente), i: dado(req.body.reteiva, calc.reteiva), c: dado(req.body.reteica, calc.reteica) };
  const total = r2(subtotal + iva - ret.f - ret.i - ret.c); // neto a pagar al proveedor

  const client = await pool.connect();
  let compraId; let pagoId = null;
  try {
    await client.query('begin');

    const vencimiento = forma_pago === 'credito'
      ? (fecha_vencimiento || new Date(Date.parse(fecha || new Date().toISOString().slice(0, 10)) + (Number(dias_plazo) || 30) * 864e5).toISOString().slice(0, 10))
      : null;
    const { rows: compraRows } = await client.query(
      `insert into compra (empresa_id, proveedor_id, numero_factura_proveedor, fecha, total, forma_pago, fecha_vencimiento, saldo, creado_por,
                           clase, subtotal, iva, concepto_retencion, retefuente, reteiva, reteica)
       values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8, $9, 'inventario', $10, $11, $12, $13, $14, $15) returning id`,
      [empresa_id, proveedor_id, numero_factura_proveedor || null, fecha || null, total, forma_pago, vencimiento, forma_pago === 'credito' ? total : 0, req.usuario?.sub,
        subtotal, iva, concepto, ret.f, ret.i, ret.c]
    );
    compraId = compraRows[0].id;

    if (forma_pago === 'contado' && total > 0) {
      const { rows: emp } = await client.query('update empresa set ultimo_pago = ultimo_pago + 1 where id = $1 returning ultimo_pago', [empresa_id]);
      const { rows: pago } = await client.query(
        `insert into pago_proveedor (empresa_id, tercero_id, consecutivo, fecha, medio_pago, total, notas, creado_por)
         values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8) returning id`,
        [empresa_id, proveedor_id, emp[0].ultimo_pago, fecha || null, medio_pago || 'efectivo', total, `Compra de contado ${numero_factura_proveedor || ''}`.trim(), req.usuario?.sub]
      );
      pagoId = pago[0].id;
      await client.query('insert into pago_proveedor_aplicacion (pago_proveedor_id, compra_id, valor) values ($1, $2, $3)', [pago[0].id, compraId, total]);
    }

    for (const item of items) {
      await client.query(
        `insert into compra_item (compra_id, producto_id, bodega_id, cantidad, costo_unitario, iva_pct)
         values ($1, $2, $3, $4, $5, $6)`,
        [compraId, item.producto_id, item.bodega_id, item.cantidad, item.costo_unitario, Number(item.iva_pct) || 0]
      );
      await registrarMovimiento(client, {
        tipo: 'compra',
        producto_id: item.producto_id,
        bodega_id: item.bodega_id,
        cantidad: item.cantidad,
        costo_unitario: item.costo_unitario,
        referencia_tipo: 'compra',
        referencia_id: compraId,
        creado_por: req.usuario?.sub,
      });
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
  await contabilizar('compra', compraId);
  if (pagoId) await contabilizar('pago_proveedor', pagoId);
  res.status(201).json({ id: compraId, subtotal, iva, retefuente: ret.f, reteiva: ret.i, reteica: ret.c, total, retencion_calculada: calc });
});

router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = `where c.clase = 'inventario'`;
  if (empresa_id) { params.push(empresa_id); where += ' and c.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select c.id, c.fecha, c.numero_factura_proveedor, c.subtotal, c.iva, c.retefuente, c.reteiva, c.reteica, c.total, c.creado_en, c.forma_pago, c.fecha_vencimiento, c.saldo,
            e.nombre as empresa, t.nombre as proveedor,
            (select count(*)::int from compra_item i where i.compra_id = c.id) as items
     from compra c
     join empresa e on e.id = c.empresa_id
     join tercero t on t.id = c.proveedor_id
     ${where}
     order by c.fecha desc, c.creado_en desc limit 200`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select i.cantidad, i.costo_unitario, i.iva_pct, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida, b.nombre as bodega
     from compra_item i join producto p on p.id = i.producto_id join bodega b on b.id = i.bodega_id
     where i.compra_id = $1 order by p.nombre`,
    [req.params.id]
  );
  res.json(rows);
});
