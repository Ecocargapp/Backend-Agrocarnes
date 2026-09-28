import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Resumen: qué productos terminados tienen receta y cuántos insumos.
router.get('/', async (_req, res) => {
  const { rows } = await pool.query(`
    select p.id as producto_terminado_id, p.nombre as producto_terminado, p.unidad_medida,
           e.nombre as empresa, count(r.id)::int as insumos
    from receta r
    join producto p on p.id = r.producto_terminado_id
    join empresa e on e.id = p.empresa_id
    group by p.id, p.nombre, p.unidad_medida, e.nombre
    order by e.nombre, p.nombre
  `);
  res.json(rows);
});

// Receta (fórmula) de un producto terminado.
router.get('/:productoTerminadoId', async (req, res) => {
  const { rows } = await pool.query(
    `select r.id, r.producto_insumo_id, i.nombre as insumo, i.unidad_medida, r.cantidad_por_unidad
     from receta r join producto i on i.id = r.producto_insumo_id
     where r.producto_terminado_id = $1
     order by i.nombre`,
    [req.params.productoTerminadoId]
  );
  res.json(rows);
});

// Reemplaza la fórmula completa.
// body: { insumos: [{ producto_insumo_id, cantidad_por_unidad }] }
router.put('/:productoTerminadoId', async (req, res) => {
  const { productoTerminadoId } = req.params;
  const { insumos } = req.body;
  if (!Array.isArray(insumos)) return res.status(400).json({ error: 'insumos debe ser una lista' });
  for (const i of insumos) {
    if (!i.producto_insumo_id || !(Number(i.cantidad_por_unidad) > 0)) {
      return res.status(400).json({ error: 'Cada insumo necesita producto_insumo_id y cantidad_por_unidad > 0' });
    }
    if (i.producto_insumo_id === productoTerminadoId) {
      return res.status(400).json({ error: 'Un producto no puede ser insumo de sí mismo' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from receta where producto_terminado_id = $1', [productoTerminadoId]);
    for (const i of insumos) {
      await client.query(
        'insert into receta (producto_terminado_id, producto_insumo_id, cantidad_por_unidad) values ($1, $2, $3)',
        [productoTerminadoId, i.producto_insumo_id, i.cantidad_por_unidad]
      );
    }
    await client.query('commit');
    res.json({ ok: true, insumos: insumos.length });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});
