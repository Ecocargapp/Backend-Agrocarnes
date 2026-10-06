// Gastos y compras de activos fijos (separados de las compras de inventario).
//
// Se guardan en la tabla `compra` con clase = 'gasto' para que entren solos a
// las cuentas por pagar y a los pagos a proveedores de Cartera. Cada renglón
// (gasto_item) es un gasto de una categoría (→ cuenta 51/52/53) o un activo
// fijo (→ cuenta 15xx + registro en activo_fijo para depreciarlo).
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { anularCompra } from '../contabilidad/anulaciones.js';
import { requireRole } from '../middleware/auth.js';
import { CATEGORIAS_GASTO, CLASES_ACTIVO } from '../contabilidad/catalogos.js';
import { calcularRetenciones } from '../contabilidad/retenciones.js';
import { contabilizar } from '../contabilidad/contabilizar.js';
import { registrarEgreso } from '../contabilidad/cuentas-pago.js';

export const router = Router();

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

router.get('/catalogos', async (_req, res) => {
  const { rows: conceptos } = await pool.query('select * from concepto_retencion order by base_uvt, codigo');
  res.json({ categorias: CATEGORIAS_GASTO, clases_activo: CLASES_ACTIVO, conceptos_retencion: conceptos });
});

// Vista previa de retenciones para el formulario (gastos y compras).
router.post('/calcular-retenciones', async (req, res) => {
  const { empresa_id, proveedor_id, concepto, base, iva } = req.body || {};
  if (!empresa_id || !proveedor_id) return res.json({ retefuente: 0, reteiva: 0, reteica: 0, motivo: 'Elige empresa y proveedor' });
  res.json(await calcularRetenciones({ empresa_id, proveedor_id, concepto, base: Number(base) || 0, iva: Number(iva) || 0 }));
});

// body: { empresa_id, proveedor_id, numero_factura_proveedor, fecha, descripcion,
//         forma_pago, dias_plazo, medio_pago, concepto_retencion,
//         retefuente?, reteiva?, reteica?   (si no vienen, se calculan)
//         items: [{ tipo: 'gasto'|'activo_fijo', categoria | clase, descripcion, valor, iva_pct, vida_util_meses? }] }
router.post('/', async (req, res) => {
  const b = req.body || {};
  const forma = b.forma_pago === 'credito' ? 'credito' : 'contado';
  if (!b.empresa_id || !b.proveedor_id || !Array.isArray(b.items) || !b.items.length) {
    return res.status(400).json({ error: 'Faltan empresa, proveedor o renglones del gasto' });
  }
  const items = [];
  for (const it of b.items) {
    const valor = r2(it.valor);
    if (!(valor > 0)) return res.status(400).json({ error: 'Cada renglón necesita un valor mayor que cero' });
    if (it.tipo === 'activo_fijo') {
      const clase = CLASES_ACTIVO[it.clase];
      if (!clase) return res.status(400).json({ error: 'Clase de activo fijo no válida' });
      if (!it.descripcion?.trim()) return res.status(400).json({ error: 'Describe el activo fijo (ej. Nevera vertical 2 puertas)' });
      const vida = it.vida_util_meses === undefined || it.vida_util_meses === '' ? clase.vida_util_meses : Number(it.vida_util_meses);
      items.push({ tipo: 'activo_fijo', categoria: it.clase, cuenta: clase.cuenta, descripcion: it.descripcion.trim(), valor, iva_pct: Number(it.iva_pct) || 0, vida });
    } else {
      const cat = CATEGORIAS_GASTO[it.categoria];
      if (!cat) return res.status(400).json({ error: 'Categoría de gasto no válida' });
      items.push({ tipo: 'gasto', categoria: it.categoria, cuenta: cat.cuenta, descripcion: it.descripcion?.trim() || cat.nombre, valor, iva_pct: Number(it.iva_pct) || 0 });
    }
  }
  const subtotal = r2(items.reduce((a, i) => a + i.valor, 0));
  const iva = r2(items.reduce((a, i) => a + r2(i.valor * i.iva_pct / 100), 0));
  const calc = await calcularRetenciones({ empresa_id: b.empresa_id, proveedor_id: b.proveedor_id, concepto: b.concepto_retencion, base: subtotal, iva });
  const ret = {
    f: b.retefuente === undefined || b.retefuente === '' ? calc.retefuente : r2(b.retefuente),
    i: b.reteiva === undefined || b.reteiva === '' ? calc.reteiva : r2(b.reteiva),
    c: b.reteica === undefined || b.reteica === '' ? calc.reteica : r2(b.reteica),
  };
  const total = r2(subtotal + iva - ret.f - ret.i - ret.c); // neto a pagar al proveedor
  if (total < 0) return res.status(400).json({ error: 'Las retenciones no pueden superar el valor del gasto' });

  const client = await pool.connect();
  let compraId; let pagoId = null; let egreso = null;
  try {
    await client.query('begin');
    const venc = forma === 'credito'
      ? new Date(Date.parse(b.fecha || new Date().toISOString().slice(0, 10)) + (Number(b.dias_plazo) || 30) * 864e5).toISOString().slice(0, 10)
      : null;
    const { rows } = await client.query(
      `insert into compra (empresa_id, proveedor_id, numero_factura_proveedor, fecha, total, forma_pago, fecha_vencimiento, saldo, creado_por,
                           clase, subtotal, iva, concepto_retencion, retefuente, reteiva, reteica, descripcion)
       values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8, $9, 'gasto', $10, $11, $12, $13, $14, $15, $16) returning id, fecha`,
      [b.empresa_id, b.proveedor_id, b.numero_factura_proveedor || null, b.fecha || null, total, forma, venc, forma === 'credito' ? total : 0, req.usuario?.sub,
        subtotal, iva, b.concepto_retencion || 'ninguna', ret.f, ret.i, ret.c, b.descripcion || null]
    );
    compraId = rows[0].id;
    for (const i of items) {
      const { rows: gi } = await client.query(
        `insert into gasto_item (compra_id, tipo, categoria, cuenta, descripcion, valor, iva_pct) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [compraId, i.tipo, i.categoria, i.cuenta, i.descripcion, i.valor, i.iva_pct]
      );
      if (i.tipo === 'activo_fijo') {
        await client.query(
          `insert into activo_fijo (empresa_id, gasto_item_id, descripcion, clase, cuenta, fecha_compra, costo, vida_util_meses)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [b.empresa_id, gi[0].id, i.descripcion, i.categoria, i.cuenta, rows[0].fecha, r2(i.valor * (1 + i.iva_pct / 100)), i.vida]
        );
      }
    }
    if (forma === 'contado' && total > 0) {
      egreso = await registrarEgreso(client, {
        empresa_id: b.empresa_id, tercero_id: b.proveedor_id, fecha: b.fecha, medio_pago: b.medio_pago || 'efectivo', cuenta_pago_id: b.cuenta_pago_id,
        referencia: b.referencia_pago, notas: `Gasto de contado ${b.numero_factura_proveedor || ''} ${b.descripcion || ''}`.trim(),
        aplicaciones: [{ compra_id: compraId, valor: total }], creado_por: req.usuario?.sub,
      });
      pagoId = egreso.id;
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
  res.status(201).json({ id: compraId, subtotal, iva, retefuente: ret.f, reteiva: ret.i, reteica: ret.c, total, retencion_calculada: calc, egreso });
});

router.get('/', async (req, res) => {
  const { empresa_id, desde, hasta } = req.query;
  const params = []; const w = [`c.clase = 'gasto'`];
  if (empresa_id) { params.push(empresa_id); w.push(`c.empresa_id = $${params.length}`); }
  if (desde) { params.push(desde); w.push(`c.fecha >= $${params.length}`); }
  if (hasta) { params.push(hasta); w.push(`c.fecha <= $${params.length}`); }
  const { rows } = await pool.query(
    `select c.id, c.estado, c.motivo_anulacion, c.fecha, c.numero_factura_proveedor, c.descripcion, c.subtotal, c.iva, c.retefuente, c.reteiva, c.reteica,
            c.total, c.forma_pago, c.saldo, e.nombre as empresa, t.nombre as proveedor,
            (select string_agg(distinct gi.categoria, ', ') from gasto_item gi where gi.compra_id = c.id) as categorias,
            exists (select 1 from gasto_item gi where gi.compra_id = c.id and gi.tipo = 'activo_fijo') as tiene_activo
     from compra c join empresa e on e.id = c.empresa_id join tercero t on t.id = c.proveedor_id
     where ${w.join(' and ')} order by c.fecha desc, c.creado_en desc limit 300`, params
  );
  res.json(rows);
});

router.get('/activos-fijos', async (req, res) => {
  const { empresa_id } = req.query;
  const params = []; let w = '';
  if (empresa_id) { params.push(empresa_id); w = 'where a.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select a.*, e.nombre as empresa,
            coalesce((select sum(l.credito) from asiento s join asiento_linea l on l.asiento_id = s.id
                      where s.origen = 'depreciacion' and s.origen_id = a.id and s.fecha <= current_date), 0) as depreciacion_acumulada
     from activo_fijo a join empresa e on e.id = a.empresa_id ${w ? `${w} and a.activo` : 'where a.activo'} order by a.fecha_compra desc`, params
  );
  res.json(rows.map((a) => ({ ...a, valor_en_libros: r2(Number(a.costo) - Number(a.depreciacion_acumulada)) })));
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('select * from gasto_item where compra_id = $1 order by tipo, categoria', [req.params.id]);
  res.json(rows);
});

router.post('/:id/anular', requireRole('admin'), async (req, res) => {
  try {
    res.json(await anularCompra(req.params.id, req.body?.motivo, req.usuario?.sub));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
