// Fórmulas (recetas) de productos terminados o intermedios.
// Se escriben por tanda: "para `cantidad_base` kg de producto uso estos insumos".
import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Resumen: qué productos tienen fórmula, cuántos insumos y la base.
router.get('/', async (_req, res) => {
  const { rows } = await pool.query(`
    select p.id as producto_terminado_id, p.nombre as producto_terminado, p.unidad_medida, p.empresa_id,
           e.nombre as empresa, count(r.id)::int as insumos, coalesce(f.cantidad_base, 1) as cantidad_base
    from receta r
    join producto p on p.id = r.producto_terminado_id
    join empresa e on e.id = p.empresa_id
    left join formula f on f.producto_terminado_id = p.id
    group by p.id, p.nombre, p.unidad_medida, p.empresa_id, e.nombre, f.cantidad_base
    order by e.nombre, p.nombre
  `);
  res.json(rows);
});

// Fórmula de un producto: { cantidad_base, notas, insumos: [...] }.
// Por compatibilidad, si se pide sin ?detalle devuelve solo la lista de insumos.
router.get('/:productoTerminadoId', async (req, res) => {
  const { rows } = await pool.query(
    `select r.id, r.producto_insumo_id, i.nombre as insumo, i.codigo, i.unidad_medida, r.cantidad_por_unidad,
            coalesce(r.cantidad, r.cantidad_por_unidad * coalesce(f.cantidad_base, 1)) as cantidad
     from receta r join producto i on i.id = r.producto_insumo_id
     left join formula f on f.producto_terminado_id = r.producto_terminado_id
     where r.producto_terminado_id = $1
     order by coalesce(r.cantidad, r.cantidad_por_unidad) desc, i.nombre`,
    [req.params.productoTerminadoId]
  );
  if (req.query.detalle === undefined) return res.json(rows);
  const { rows: f } = await pool.query('select cantidad_base, notas from formula where producto_terminado_id = $1', [req.params.productoTerminadoId]);
  res.json({ cantidad_base: Number(f[0]?.cantidad_base || 1), notas: f[0]?.notas || '', insumos: rows });
});

// Reemplaza la fórmula completa.
// body: { cantidad_base?, notas?, insumos: [{ producto_insumo_id, cantidad }] }
//   (también acepta cantidad_por_unidad, el formato anterior, con base 1)
router.put('/:productoTerminadoId', async (req, res) => {
  const { productoTerminadoId } = req.params;
  const { insumos, notas } = req.body || {};
  const base = Number(req.body?.cantidad_base || 1);
  if (!(base > 0)) return res.status(400).json({ error: 'La cantidad base de la fórmula debe ser mayor que cero' });
  if (!Array.isArray(insumos) || !insumos.length) return res.status(400).json({ error: 'La fórmula necesita al menos un insumo' });
  const vistos = new Set();
  for (const i of insumos) {
    const cant = Number(i.cantidad ?? i.cantidad_por_unidad);
    if (!i.producto_insumo_id || !(cant > 0)) {
      return res.status(400).json({ error: 'Cada insumo necesita producto y cantidad mayor que cero' });
    }
    if (i.producto_insumo_id === productoTerminadoId) return res.status(400).json({ error: 'Un producto no puede ser insumo de sí mismo' });
    if (vistos.has(i.producto_insumo_id)) return res.status(400).json({ error: 'Hay un insumo repetido en la fórmula' });
    vistos.add(i.producto_insumo_id);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from receta where producto_terminado_id = $1', [productoTerminadoId]);
    for (const i of insumos) {
      const cant = Number(i.cantidad ?? i.cantidad_por_unidad);
      await client.query(
        'insert into receta (producto_terminado_id, producto_insumo_id, cantidad, cantidad_por_unidad) values ($1, $2, $3, $4)',
        [productoTerminadoId, i.producto_insumo_id, cant, cant / base]
      );
    }
    await client.query(
      `insert into formula (producto_terminado_id, cantidad_base, notas, actualizado_en) values ($1, $2, $3, now())
       on conflict (producto_terminado_id) do update set cantidad_base = excluded.cantidad_base, notas = excluded.notas, actualizado_en = now()`,
      [productoTerminadoId, base, notas || null]
    );
    await client.query('commit');
    res.json({ ok: true, insumos: insumos.length });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Borra la fórmula de un producto.
router.delete('/:productoTerminadoId', async (req, res) => {
  await pool.query('delete from receta where producto_terminado_id = $1', [req.params.productoTerminadoId]);
  await pool.query('delete from formula where producto_terminado_id = $1', [req.params.productoTerminadoId]);
  res.json({ ok: true });
});
