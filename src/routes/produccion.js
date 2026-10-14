// Producción con fórmula: descarga del inventario los insumos usados y carga
// el producto terminado al costo de esos insumos.
//
//   POST /produccion/previsualizar  { producto_terminado_id, bodega_id, cantidad_producida }
//        → insumos teóricos con existencia, costo y faltantes
//   POST /produccion  { empresa_id?, producto_terminado_id, bodega_id, cantidad_producida,
//                       insumos?: [{ producto_insumo_id, cantidad }],   ← cantidades reales usadas (opcional)
//                       lote?, notas?, fecha? }
//   GET  /produccion, GET /produccion/:id, POST /produccion/:id/anular
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { anularProduccion } from '../contabilidad/anulaciones.js';
import { requireRole } from '../middleware/auth.js';
import { registrarMovimiento } from '../db/inventario.js';

export const router = Router();
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

// Insumos teóricos de la fórmula para producir `cantidad`, con la existencia
// y el costo promedio en la bodega.
async function calcular(db, { producto_terminado_id, bodega_id, cantidad, reales = null }) {
  const { rows: receta } = await db.query(
    `select r.producto_insumo_id, r.cantidad_por_unidad, i.nombre, i.codigo, i.unidad_medida
     from receta r join producto i on i.id = r.producto_insumo_id where r.producto_terminado_id = $1 order by r.cantidad_por_unidad desc`,
    [producto_terminado_id]
  );
  if (!receta.length) throw new Error('Este producto no tiene fórmula. Créala en la pestaña Fórmulas.');
  const lineas = receta.map((r) => ({
    producto_insumo_id: r.producto_insumo_id, insumo: `${r.codigo ? `${r.codigo} · ` : ''}${r.nombre}`, unidad_medida: r.unidad_medida,
    teorica: r3(Number(r.cantidad_por_unidad) * cantidad),
  }));
  // Cantidades reales (si se dieron): reemplazan a las teóricas y pueden agregar insumos.
  if (Array.isArray(reales)) {
    const porId = new Map(reales.map((x) => [x.producto_insumo_id, r3(x.cantidad)]));
    for (const l of lineas) l.cantidad = porId.has(l.producto_insumo_id) ? porId.get(l.producto_insumo_id) : l.teorica;
    const extra = reales.filter((x) => !lineas.some((l) => l.producto_insumo_id === x.producto_insumo_id) && Number(x.cantidad) > 0);
    if (extra.length) {
      const { rows } = await db.query('select id, nombre, codigo, unidad_medida from producto where id = any($1)', [extra.map((x) => x.producto_insumo_id)]);
      for (const x of extra) {
        const p = rows.find((y) => y.id === x.producto_insumo_id);
        if (!p) throw new Error('Insumo no encontrado');
        lineas.push({ producto_insumo_id: p.id, insumo: `${p.codigo ? `${p.codigo} · ` : ''}${p.nombre}`, unidad_medida: p.unidad_medida, teorica: 0, cantidad: r3(x.cantidad) });
      }
    }
  } else {
    for (const l of lineas) l.cantidad = l.teorica;
  }
  const { rows: ex } = await db.query(
    'select producto_id, cantidad, costo_promedio from existencia where bodega_id = $1 and producto_id = any($2)',
    [bodega_id, lineas.map((l) => l.producto_insumo_id)]
  );
  let costo = 0;
  for (const l of lineas) {
    const e = ex.find((x) => x.producto_id === l.producto_insumo_id);
    l.existencia = Number(e?.cantidad || 0);
    l.costo_unitario = Number(e?.costo_promedio || 0);
    l.costo = Math.round(l.cantidad * l.costo_unitario * 100) / 100;
    l.falta = l.cantidad > l.existencia + 1e-9 ? r3(l.cantidad - l.existencia) : 0;
    costo += l.costo;
  }
  return {
    lineas: lineas.filter((l) => l.cantidad > 0 || l.teorica > 0),
    costo_total: Math.round(costo * 100) / 100,
    costo_unitario: cantidad > 0 ? Math.round((costo / cantidad) * 100) / 100 : 0,
    faltantes: lineas.filter((l) => l.falta > 0),
  };
}

router.post('/previsualizar', async (req, res) => {
  try {
    const { producto_terminado_id, bodega_id, insumos } = req.body || {};
    const cantidad = Number(req.body?.cantidad_producida);
    if (!producto_terminado_id || !bodega_id || !(cantidad > 0)) throw new Error('Indica producto, bodega y cantidad');
    res.json(await calcular(pool, { producto_terminado_id, bodega_id, cantidad, reales: insumos || null }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { producto_terminado_id, bodega_id, insumos, lote, notas, fecha } = req.body || {};
  const cantidad = Number(req.body?.cantidad_producida);
  if (!producto_terminado_id || !bodega_id || !(cantidad > 0)) {
    return res.status(400).json({ error: 'Faltan el producto, la bodega o la cantidad producida' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: b } = await client.query('select empresa_id, nombre from bodega where id = $1', [bodega_id]);
    if (!b[0]) throw new Error('Bodega no encontrada');
    const empresa_id = b[0].empresa_id;
    const calc = await calcular(client, { producto_terminado_id, bodega_id, cantidad, reales: insumos || null });
    if (calc.faltantes.length) {
      throw new Error(`No hay suficiente inventario en ${b[0].nombre}: ${calc.faltantes.map((f) => `${f.insumo} (necesitas ${f.cantidad} ${f.unidad_medida}, hay ${r3(f.existencia)})`).join('; ')}. Registra la compra o el traslado del insumo primero.`);
    }

    const { rows: o } = await client.query(
      `insert into orden_produccion (empresa_id, producto_terminado_id, cantidad_producida, bodega_id, creado_por, lote, notas, fecha)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, (now() at time zone 'America/Bogota')::date)) returning id`,
      [empresa_id, producto_terminado_id, cantidad, bodega_id, req.usuario?.sub || null, lote || null, notas || null, fecha || null]
    );
    const ordenId = o[0].id;

    let costoTotal = 0;
    for (const l of calc.lineas) {
      if (!(l.cantidad > 0)) continue;
      await registrarMovimiento(client, {
        tipo: 'produccion_consumo', producto_id: l.producto_insumo_id, bodega_id,
        cantidad: l.cantidad, costo_unitario: l.costo_unitario,
        referencia_tipo: 'orden_produccion', referencia_id: ordenId, creado_por: req.usuario?.sub,
      });
      costoTotal += l.cantidad * l.costo_unitario;
    }
    const costoUnitario = costoTotal / cantidad;
    await registrarMovimiento(client, {
      tipo: 'produccion_entrada', producto_id: producto_terminado_id, bodega_id,
      cantidad, costo_unitario: costoUnitario,
      referencia_tipo: 'orden_produccion', referencia_id: ordenId, creado_por: req.usuario?.sub,
    });
    await client.query('update orden_produccion set costo_unitario = $1 where id = $2', [costoUnitario, ordenId]);
    await client.query('commit');
    res.status(201).json({ id: ordenId, costo_unitario_terminado: Math.round(costoUnitario * 100) / 100, costo_total: Math.round(costoTotal * 100) / 100, insumos: calc.lineas.length });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/', async (_req, res) => {
  const { rows } = await pool.query(`
    select o.id, o.estado, o.motivo_anulacion, o.creado_en, o.fecha, o.lote, o.notas,
           coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida, o.cantidad_producida,
           o.costo_unitario, b.nombre as bodega, e.nombre as empresa
    from orden_produccion o
    join producto p on p.id = o.producto_terminado_id
    join bodega b on b.id = o.bodega_id
    join empresa e on e.id = o.empresa_id
    order by o.creado_en desc limit 200
  `);
  res.json(rows);
});

// Detalle: insumos consumidos (teórico vs. real) y producto obtenido.
router.get('/:id', async (req, res) => {
  const { rows: o } = await pool.query(
    `select o.*, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida, b.nombre as bodega
     from orden_produccion o join producto p on p.id = o.producto_terminado_id join bodega b on b.id = o.bodega_id where o.id = $1`,
    [req.params.id]
  );
  if (!o[0]) return res.status(404).json({ error: 'Producción no encontrada' });
  const { rows: movs } = await pool.query(
    `select m.tipo, m.cantidad, m.costo_unitario, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida,
            (select r.cantidad_por_unidad from receta r where r.producto_terminado_id = $2 and r.producto_insumo_id = m.producto_id) as por_unidad
     from movimiento_inventario m join producto p on p.id = m.producto_id
     where m.referencia_tipo = 'orden_produccion' and m.referencia_id = $1 and m.tipo = 'produccion_consumo' order by m.cantidad desc`,
    [req.params.id, o[0].producto_terminado_id]
  );
  res.json({
    ...o[0],
    insumos: movs.map((m) => ({
      producto: m.producto, unidad_medida: m.unidad_medida, cantidad: Number(m.cantidad), costo_unitario: Number(m.costo_unitario),
      costo: Math.round(Number(m.cantidad) * Number(m.costo_unitario) * 100) / 100,
      teorica: m.por_unidad == null ? null : r3(Number(m.por_unidad) * Number(o[0].cantidad_producida)),
    })),
  });
});

router.post('/:id/anular', requireRole('admin'), async (req, res) => {
  try {
    res.json(await anularProduccion(req.params.id, req.body?.motivo, req.usuario?.sub));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
