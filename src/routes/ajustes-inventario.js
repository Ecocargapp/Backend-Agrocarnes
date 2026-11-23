// Ajustes de inventario (cuadre / toma física).
//
// Se registra la CANTIDAD CONTADA de cada producto en una bodega. El sistema
// compara contra la existencia de ese momento y:
//   - sobrante (contada > sistema): entra la diferencia al costo promedio
//     (o al último costo conocido si no hay existencia) → Dr 1435 Cr 4250.
//   - faltante (contada < sistema): sale la diferencia al costo promedio y se
//     lleva según el motivo de la línea:
//       merma   → costo de ventas (61359502)   pérdida → 53959502
//       consumo → consumo interno/obsequios (51959501)   conteo → 53959503
// Las líneas sin diferencia quedan registradas como parte del conteo.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { registrarMovimiento } from '../db/inventario.js';
import { contabilizar } from '../contabilidad/contabilizar.js';
import { anularAjuste } from '../contabilidad/anulaciones.js';

export const router = Router();

const MOTIVOS_FALTANTE = new Set(['merma', 'perdida', 'consumo', 'conteo']);
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
export const numeroAjuste = (n) => `AJ-${String(n).padStart(4, '0')}`;

// Lista: /ajustes-inventario?bodega_id=
router.get('/', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.bodega_id) { params.push(req.query.bodega_id); where = 'where a.bodega_id = $1'; }
  const { rows } = await pool.query(
    `select a.id, a.numero, to_char(a.fecha, 'YYYY-MM-DD') as fecha, a.observacion, a.estado, a.motivo_anulacion, a.creado_en,
            b.nombre as bodega, e.nombre as empresa, u.nombre as usuario,
            count(i.id)::int as productos,
            count(i.id) filter (where i.diferencia <> 0)::int as con_diferencia,
            coalesce(sum(case when i.diferencia > 0 then i.diferencia * i.costo_unitario else 0 end), 0) as valor_sobrante,
            coalesce(sum(case when i.diferencia < 0 then -i.diferencia * i.costo_unitario else 0 end), 0) as valor_faltante
     from ajuste_inventario a
     join bodega b on b.id = a.bodega_id join empresa e on e.id = a.empresa_id
     left join usuario u on u.id = a.creado_por
     left join ajuste_inventario_item i on i.ajuste_id = a.id
     ${where}
     group by a.id, b.nombre, e.nombre, u.nombre
     order by a.creado_en desc limit 200`, params
  );
  res.json(rows.map((r) => ({ ...r, documento: numeroAjuste(r.numero) })));
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select a.*, to_char(a.fecha, 'YYYY-MM-DD') as fecha, b.nombre as bodega, e.nombre as empresa, u.nombre as usuario
     from ajuste_inventario a join bodega b on b.id = a.bodega_id join empresa e on e.id = a.empresa_id
     left join usuario u on u.id = a.creado_por where a.id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ajuste no encontrado' });
  const { rows: items } = await pool.query(
    `select i.*, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida
     from ajuste_inventario_item i join producto p on p.id = i.producto_id
     where i.ajuste_id = $1 order by p.codigo nulls last, p.nombre`, [req.params.id]
  );
  res.json({ ...rows[0], documento: numeroAjuste(rows[0].numero), items });
});

// Crea el ajuste. body: { bodega_id, fecha?, observacion?, items: [{ producto_id, cantidad_contada, motivo?, costo_unitario? }] }
router.post('/', requireRole('admin'), async (req, res) => {
  const { bodega_id, fecha, observacion } = req.body || {};
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!bodega_id) return res.status(400).json({ error: 'Falta la bodega' });
  if (!items.length) return res.status(400).json({ error: 'Agrega al menos un producto contado' });
  const vistos = new Set();
  for (const [i, it] of items.entries()) {
    const c = Number(it.cantidad_contada);
    if (!it.producto_id) return res.status(400).json({ error: `Línea ${i + 1}: falta el producto` });
    if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: `Línea ${i + 1}: la cantidad contada debe ser 0 o más` });
    if (vistos.has(it.producto_id)) return res.status(400).json({ error: `Línea ${i + 1}: el producto está repetido` });
    vistos.add(it.producto_id);
    if (it.motivo && !MOTIVOS_FALTANTE.has(it.motivo)) return res.status(400).json({ error: `Línea ${i + 1}: motivo no válido` });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: b } = await client.query('select id, empresa_id, nombre from bodega where id = $1', [bodega_id]);
    if (!b[0]) throw new Error('Bodega no encontrada');

    // Consecutivo sin huecos: se toma bajo un candado para que dos ajustes simultáneos no choquen.
    await client.query('select pg_advisory_xact_lock(4243)');
    const { rows: aj } = await client.query(
      `insert into ajuste_inventario (numero, empresa_id, bodega_id, fecha, observacion, creado_por)
       values ((select coalesce(max(numero), 0) + 1 from ajuste_inventario), $1, $2, coalesce($3::date, (now() at time zone 'America/Bogota')::date), $4, $5) returning id, numero`,
      [b[0].empresa_id, bodega_id, fecha || null, observacion?.trim() || null, req.usuario?.sub || null]
    );
    const ajusteId = aj[0].id;
    const resumen = { sobrantes: 0, faltantes: 0, sin_diferencia: 0, valor_sobrante: 0, valor_faltante: 0 };

    for (const [i, it] of items.entries()) {
      const { rows: p } = await client.query('select nombre, maneja_inventario from producto where id = $1', [it.producto_id]);
      if (!p[0]) throw new Error(`Línea ${i + 1}: producto no encontrado`);
      if (p[0].maneja_inventario === false) throw new Error(`"${p[0].nombre}" no maneja inventario`);
      // Existencia del momento, bloqueada para que nadie la cambie mientras se ajusta.
      const { rows: ex } = await client.query(
        'select cantidad, costo_promedio from existencia where bodega_id = $1 and producto_id = $2 for update', [bodega_id, it.producto_id]
      );
      const sistema = r3(ex[0]?.cantidad || 0);
      const contada = r3(it.cantidad_contada);
      const diferencia = r3(contada - sistema);
      let costo = Number(ex[0]?.costo_promedio || 0);
      if (diferencia > 0 && !(costo > 0)) {
        // Sin costo en esta bodega: el que indique el usuario o el último costo conocido del producto.
        costo = Number(it.costo_unitario) > 0 ? Number(it.costo_unitario) : 0;
        if (!(costo > 0)) {
          const { rows: u } = await client.query(
            `select costo_unitario from movimiento_inventario where producto_id = $1 and costo_unitario > 0 order by creado_en desc limit 1`, [it.producto_id]
          );
          costo = Number(u[0]?.costo_unitario || 0);
        }
        if (!(costo > 0)) throw new Error(`"${p[0].nombre}" no tiene costo conocido: escribe el costo unitario del sobrante`);
      }
      const motivo = diferencia === 0 ? 'sin_diferencia' : diferencia > 0 ? 'sobrante' : (it.motivo || 'conteo');
      await client.query(
        `insert into ajuste_inventario_item (ajuste_id, producto_id, cantidad_sistema, cantidad_contada, diferencia, costo_unitario, motivo)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [ajusteId, it.producto_id, sistema, contada, diferencia, costo, motivo]
      );
      if (diferencia !== 0) {
        await registrarMovimiento(client, {
          tipo: diferencia > 0 ? 'ajuste_entrada' : 'ajuste_salida', producto_id: it.producto_id, bodega_id,
          cantidad: Math.abs(diferencia), costo_unitario: costo,
          referencia_tipo: 'ajuste_inventario', referencia_id: ajusteId, creado_por: req.usuario?.sub,
        });
      }
      const valor = Math.abs(diferencia) * costo;
      if (diferencia > 0) { resumen.sobrantes++; resumen.valor_sobrante += valor; }
      else if (diferencia < 0) { resumen.faltantes++; resumen.valor_faltante += valor; }
      else resumen.sin_diferencia++;
    }

    await client.query('commit');
    await contabilizar('ajuste_inventario', ajusteId);
    resumen.valor_sobrante = Math.round(resumen.valor_sobrante * 100) / 100;
    resumen.valor_faltante = Math.round(resumen.valor_faltante * 100) / 100;
    res.status(201).json({ id: ajusteId, documento: numeroAjuste(aj[0].numero), ...resumen });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/:id/anular', requireRole('admin'), async (req, res) => {
  try {
    res.json(await anularAjuste(req.params.id, req.body?.motivo, req.usuario?.sub));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
