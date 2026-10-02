import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Saldo actual, opcionalmente filtrado por bodega: /inventario/existencias?bodega_id=...
router.get('/existencias', async (req, res) => {
  const { bodega_id } = req.query;
  const params = [];
  let sql = `
    select e.bodega_id, e.producto_id, p.codigo, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida,
           e.cantidad, e.costo_promedio, e.actualizado_en
    from existencia e
    join producto p on p.id = e.producto_id
  `;
  if (bodega_id) {
    params.push(bodega_id);
    sql += ' where e.bodega_id = $1';
  }
  sql += ' order by p.codigo nulls last, p.nombre';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// Kardex de un producto en una bodega: /inventario/movimientos?producto_id=...&bodega_id=...
router.get('/movimientos', async (req, res) => {
  const { producto_id, bodega_id } = req.query;
  const conditions = [];
  const params = [];
  if (producto_id) { params.push(producto_id); conditions.push(`producto_id = $${params.length}`); }
  if (bodega_id) { params.push(bodega_id); conditions.push(`bodega_id = $${params.length}`); }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select * from movimiento_inventario ${where} order by creado_en desc limit 500`,
    params
  );
  res.json(rows);
});
