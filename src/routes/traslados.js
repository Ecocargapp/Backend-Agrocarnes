import { Router } from 'express';
import { pool } from '../db/pool.js';
import { anularTraslado } from '../contabilidad/anulaciones.js';
import { requireRole } from '../middleware/auth.js';
import { registrarMovimiento } from '../db/inventario.js';
import { contabilizar } from '../contabilidad/contabilizar.js';

export const router = Router();

// Mueve producto de una bodega a otra (ej. Agrocarnes -> Restaurante, o
// Agrocarnes -> D'Monsa la carne para embutidos). Por defecto es un traslado
// interno sin factura, al costo. Si tu contador pide facturarlo entre
// compañías, marca es_venta_intercompania y pasa factura_venta_id (esa
// factura se crea aparte, en /ventas, con este mismo producto).
router.post('/', async (req, res) => {
  const {
    producto_id, bodega_origen_id, bodega_destino_id, cantidad,
    es_venta_intercompania = false, factura_venta_id = null,
  } = req.body;
  if (!producto_id || !bodega_origen_id || !bodega_destino_id || !cantidad) {
    return res.status(400).json({ error: 'Faltan producto_id, bodega_origen_id, bodega_destino_id o cantidad' });
  }
  if (bodega_origen_id === bodega_destino_id) {
    return res.status(400).json({ error: 'La bodega de origen y destino no pueden ser la misma' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const { rows: existRows } = await client.query(
      'select costo_promedio from existencia where bodega_id = $1 and producto_id = $2',
      [bodega_origen_id, producto_id]
    );
    if (existRows.length === 0) throw new Error('El producto no tiene existencia en la bodega de origen');
    const costoUnitario = existRows[0].costo_promedio;

    const { rows: traslabRows } = await client.query(
      `insert into traslado (producto_id, bodega_origen_id, bodega_destino_id, cantidad, costo_unitario, es_venta_intercompania, factura_venta_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [producto_id, bodega_origen_id, bodega_destino_id, cantidad, costoUnitario, es_venta_intercompania, factura_venta_id]
    );
    const trasladoId = traslabRows[0].id;

    await registrarMovimiento(client, {
      tipo: 'traslado_salida', producto_id, bodega_id: bodega_origen_id, cantidad, costo_unitario: costoUnitario,
      referencia_tipo: 'traslado', referencia_id: trasladoId, creado_por: req.usuario?.sub,
    });
    await registrarMovimiento(client, {
      tipo: 'traslado_entrada', producto_id, bodega_id: bodega_destino_id, cantidad, costo_unitario: costoUnitario,
      referencia_tipo: 'traslado', referencia_id: trasladoId, creado_por: req.usuario?.sub,
    });

    await client.query('commit');
    await contabilizar('traslado', trasladoId);
    res.status(201).json({ id: trasladoId, costo_unitario: costoUnitario });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/', async (_req, res) => {
  const { rows } = await pool.query(`
    select t.id, t.estado, t.motivo_anulacion, t.creado_en, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida, t.cantidad, t.costo_unitario,
           bo.nombre as bodega_origen, eo.nombre as empresa_origen,
           bd.nombre as bodega_destino, ed.nombre as empresa_destino,
           t.es_venta_intercompania
    from traslado t
    join producto p on p.id = t.producto_id
    join bodega bo on bo.id = t.bodega_origen_id join empresa eo on eo.id = bo.empresa_id
    join bodega bd on bd.id = t.bodega_destino_id join empresa ed on ed.id = bd.empresa_id
    order by t.creado_en desc limit 200
  `);
  res.json(rows);
});

router.post('/:id/anular', requireRole('admin'), async (req, res) => {
  try {
    res.json(await anularTraslado(req.params.id, req.body?.motivo, req.usuario?.sub));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
