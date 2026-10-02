import { Router } from 'express';
import { pool } from '../db/pool.js';
import { registrarMovimiento } from '../db/inventario.js';

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

  const client = await pool.connect();
  try {
    await client.query('begin');

    const total = items.reduce((acc, it) => acc + Number(it.cantidad) * Number(it.costo_unitario), 0);
    const vencimiento = forma_pago === 'credito'
      ? (fecha_vencimiento || new Date(Date.parse(fecha || new Date().toISOString().slice(0, 10)) + (Number(dias_plazo) || 30) * 864e5).toISOString().slice(0, 10))
      : null;
    const { rows: compraRows } = await client.query(
      `insert into compra (empresa_id, proveedor_id, numero_factura_proveedor, fecha, total, forma_pago, fecha_vencimiento, saldo, creado_por)
       values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8, $9) returning id`,
      [empresa_id, proveedor_id, numero_factura_proveedor || null, fecha || null, total, forma_pago, vencimiento, forma_pago === 'credito' ? total : 0, req.usuario?.sub]
    );
    const compraId = compraRows[0].id;

    if (forma_pago === 'contado' && total > 0) {
      const { rows: emp } = await client.query('update empresa set ultimo_pago = ultimo_pago + 1 where id = $1 returning ultimo_pago', [empresa_id]);
      const { rows: pago } = await client.query(
        `insert into pago_proveedor (empresa_id, tercero_id, consecutivo, fecha, medio_pago, total, notas, creado_por)
         values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8) returning id`,
        [empresa_id, proveedor_id, emp[0].ultimo_pago, fecha || null, medio_pago || 'efectivo', total, `Compra de contado ${numero_factura_proveedor || ''}`.trim(), req.usuario?.sub]
      );
      await client.query('insert into pago_proveedor_aplicacion (pago_proveedor_id, compra_id, valor) values ($1, $2, $3)', [pago[0].id, compraId, total]);
    }

    for (const item of items) {
      await client.query(
        `insert into compra_item (compra_id, producto_id, bodega_id, cantidad, costo_unitario)
         values ($1, $2, $3, $4, $5)`,
        [compraId, item.producto_id, item.bodega_id, item.cantidad, item.costo_unitario]
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
    res.status(201).json({ id: compraId, total });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = '';
  if (empresa_id) { params.push(empresa_id); where = 'where c.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select c.id, c.fecha, c.numero_factura_proveedor, c.total, c.creado_en, c.forma_pago, c.fecha_vencimiento, c.saldo,
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
    `select i.cantidad, i.costo_unitario, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida, b.nombre as bodega
     from compra_item i join producto p on p.id = i.producto_id join bodega b on b.id = i.bodega_id
     where i.compra_id = $1 order by p.nombre`,
    [req.params.id]
  );
  res.json(rows);
});
