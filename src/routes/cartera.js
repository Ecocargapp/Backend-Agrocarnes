// Cartera: cuentas por cobrar (clientes) y por pagar (proveedores).
//
//   GET  /cartera/clientes?empresa_id=       resumen por cliente con antigüedad
//   GET  /cartera/clientes/:terceroId/documentos?empresa_id=   facturas con saldo
//   POST /cartera/recibos                    recibo de caja: cobra una o varias facturas
//   GET  /cartera/recibos?empresa_id=
//   GET  /cartera/proveedores?empresa_id=    resumen por proveedor con antigüedad
//   GET  /cartera/proveedores/:terceroId/documentos?empresa_id=
//   POST /cartera/pagos                      pago a proveedor: paga una o varias compras
//   GET  /cartera/pagos?empresa_id=
//
// El saldo vive en factura_venta.saldo / compra.saldo y solo cambia aquí
// (y al anular o aplicar una nota crédito). Todo en transacciones.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { anularRecibo, anularEgreso } from '../contabilidad/anulaciones.js';
import { requireRole } from '../middleware/auth.js';
import { contabilizar } from '../contabilidad/contabilizar.js';
import { registrarEgreso, resolverCuentaPago } from '../contabilidad/cuentas-pago.js';

export const router = Router();

const ANTIGUEDAD = `
  sum(case when saldo > 0 and (fecha_vencimiento is null or fecha_vencimiento >= current_date) then saldo else 0 end) as por_vencer,
  sum(case when saldo > 0 and fecha_vencimiento < current_date and current_date - fecha_vencimiento <= 30 then saldo else 0 end) as vencido_1_30,
  sum(case when saldo > 0 and current_date - fecha_vencimiento between 31 and 60 then saldo else 0 end) as vencido_31_60,
  sum(case when saldo > 0 and current_date - fecha_vencimiento between 61 and 90 then saldo else 0 end) as vencido_61_90,
  sum(case when saldo > 0 and current_date - fecha_vencimiento > 90 then saldo else 0 end) as vencido_mas_90,
  sum(case when saldo > 0 and fecha_vencimiento < current_date then saldo else 0 end) as vencido,
  sum(saldo) as saldo,
  count(*) filter (where saldo > 0)::int as documentos`;

// ------------------------------------------------------------ clientes (CxC)
router.get('/clientes', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = "where f.estado = 'vigente' and f.saldo > 0";
  if (empresa_id) { params.push(empresa_id); where += ` and f.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select coalesce(t.id::text, 'consumidor_final') as tercero_id, coalesce(t.nombre, 'Consumidor final') as cliente,
            t.numero_documento, t.telefono, e.nombre as empresa, ${ANTIGUEDAD}
     from factura_venta f
     join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id
     ${where}
     group by t.id, t.nombre, t.numero_documento, t.telefono, e.nombre
     order by vencido desc, saldo desc`,
    params
  );
  res.json(rows);
});

// Todas las facturas con saldo, de todos los clientes (para exportar a Excel
// con fecha de factura y fecha de vencimiento). query: empresa_id.
router.get('/clientes/documentos', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = "where f.estado = 'vigente' and f.saldo > 0";
  if (empresa_id) { params.push(empresa_id); where += ` and f.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select f.id, f.consecutivo, f.fecha, f.fecha_vencimiento, f.total, f.saldo, f.forma_pago, e.nombre as empresa,
            coalesce(t.nombre, 'Consumidor final') as cliente, t.numero_documento,
            greatest(0, current_date - f.fecha_vencimiento) as dias_vencido
     from factura_venta f join empresa e on e.id = f.empresa_id left join tercero t on t.id = f.cliente_id
     ${where}
     order by f.fecha_vencimiento nulls last, f.fecha`,
    params
  );
  res.json(rows);
});

router.get('/clientes/:terceroId/documentos', async (req, res) => {
  const { empresa_id } = req.query;
  const esConsumidor = req.params.terceroId === 'consumidor_final';
  const params = [];
  let where = `where f.estado = 'vigente' and ${esConsumidor ? 'f.cliente_id is null' : 'f.cliente_id = $1'}`;
  if (!esConsumidor) params.push(req.params.terceroId);
  if (empresa_id) { params.push(empresa_id); where += ` and f.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select f.id, f.consecutivo, f.fecha, f.fecha_vencimiento, f.total, f.saldo, f.forma_pago, e.nombre as empresa,
            greatest(0, current_date - f.fecha_vencimiento) as dias_vencido
     from factura_venta f join empresa e on e.id = f.empresa_id
     ${where}
     order by f.saldo > 0 desc, f.fecha_vencimiento nulls last, f.fecha
     limit 300`,
    params
  );
  res.json(rows);
});

// body: { empresa_id, tercero_id, fecha, medio_pago, notas, aplicaciones: [{ factura_venta_id, valor }],
//         retefuente, reteiva, reteica }  ← retenciones que el CLIENTE nos practicó al pagar
// Las aplicaciones bajan el saldo de las facturas por su valor completo; el
// dinero que entra es ese valor menos las retenciones.
router.post('/recibos', async (req, res) => {
  const { empresa_id, tercero_id, fecha, medio_pago, notas, aplicaciones } = req.body;
  const ret = ['retefuente', 'reteiva', 'reteica'].map((k) => Math.round(Number(req.body[k] || 0) * 100) / 100);
  if (ret.some((v) => v < 0)) return res.status(400).json({ error: 'Las retenciones no pueden ser negativas' });
  if (!empresa_id || !Array.isArray(aplicaciones) || aplicaciones.length === 0) {
    return res.status(400).json({ error: 'Faltan empresa_id o aplicaciones' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    let total = 0;
    for (const a of aplicaciones) {
      const valor = Number(a.valor);
      if (!(valor > 0)) throw new Error('Cada aplicación debe tener un valor mayor que cero');
      const { rows } = await client.query(
        `select consecutivo, saldo, estado, cliente_id, empresa_id from factura_venta where id = $1 for update`,
        [a.factura_venta_id]
      );
      const f = rows[0];
      if (!f) throw new Error('Factura no encontrada');
      if (f.estado !== 'vigente') throw new Error(`La factura ${f.consecutivo} está anulada`);
      if (f.empresa_id !== empresa_id) throw new Error(`La factura ${f.consecutivo} es de otra empresa`);
      if (valor > Number(f.saldo) + 0.005) throw new Error(`El valor supera el saldo de la factura ${f.consecutivo} (${f.saldo})`);
      total += valor;
    }
    if (ret[0] + ret[1] + ret[2] > total) throw new Error('Las retenciones no pueden superar el valor aplicado a las facturas');
    const destino = await resolverCuentaPago(client, { empresa_id, medio_pago: medio_pago || 'efectivo', cuenta_pago_id: req.body.cuenta_pago_id, sentido: 'ingreso' });
    const { rows: emp } = await client.query(
      'update empresa set ultimo_recibo = ultimo_recibo + 1 where id = $1 returning ultimo_recibo', [empresa_id]
    );
    const { rows: rec } = await client.query(
      `insert into recibo_caja (empresa_id, tercero_id, consecutivo, fecha, medio_pago, total, notas, creado_por, retefuente, reteiva, reteica, cuenta_pago_id, referencia)
       values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id, consecutivo`,
      [empresa_id, tercero_id || null, emp[0].ultimo_recibo, fecha || null, medio_pago || 'efectivo', total, notas || null, req.usuario?.sub, ...ret,
        destino?.id || null, req.body.referencia || null]
    );
    for (const a of aplicaciones) {
      await client.query(
        'insert into recibo_caja_aplicacion (recibo_caja_id, factura_venta_id, valor) values ($1, $2, $3)',
        [rec[0].id, a.factura_venta_id, Number(a.valor)]
      );
      await client.query('update factura_venta set saldo = round(saldo - $1, 2) where id = $2', [Number(a.valor), a.factura_venta_id]);
    }
    await client.query('commit');
    await contabilizar('recibo_caja', rec[0].id);
    res.status(201).json({ id: rec[0].id, consecutivo: rec[0].consecutivo, total, recibido: Math.round((total - ret[0] - ret[1] - ret[2]) * 100) / 100 });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/recibos', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = '';
  if (empresa_id) { params.push(empresa_id); where = 'where r.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select r.id, r.estado, r.motivo_anulacion, r.consecutivo, r.fecha, r.medio_pago, r.referencia, r.total, r.notas, e.nombre as empresa,
            (select nombre from cuenta_pago where id = r.cuenta_pago_id) as cuenta_pago,
            coalesce(t.nombre, 'Consumidor final') as cliente,
            (select string_agg(f.consecutivo, ', ' order by f.consecutivo)
               from recibo_caja_aplicacion a join factura_venta f on f.id = a.factura_venta_id
              where a.recibo_caja_id = r.id) as facturas
     from recibo_caja r join empresa e on e.id = r.empresa_id left join tercero t on t.id = r.tercero_id
     ${where} order by r.fecha desc, r.creado_en desc limit 200`,
    params
  );
  res.json(rows);
});

// -------------------------------------------------------- proveedores (CxP)
router.get('/proveedores', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = 'where c.saldo > 0';
  if (empresa_id) { params.push(empresa_id); where += ` and c.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select t.id as tercero_id, t.nombre as proveedor, t.numero_documento, t.telefono, e.nombre as empresa, ${ANTIGUEDAD}
     from compra c join empresa e on e.id = c.empresa_id join tercero t on t.id = c.proveedor_id
     ${where}
     group by t.id, t.nombre, t.numero_documento, t.telefono, e.nombre
     order by vencido desc, saldo desc`,
    params
  );
  res.json(rows);
});

// Igual que /clientes/documentos pero para cuentas por pagar.
router.get('/proveedores/documentos', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = 'where c.saldo > 0';
  if (empresa_id) { params.push(empresa_id); where += ` and c.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select c.id, c.clase, c.descripcion, c.numero_factura_proveedor, c.fecha, c.fecha_vencimiento, c.total, c.saldo, c.forma_pago, e.nombre as empresa,
            t.nombre as proveedor, t.numero_documento,
            greatest(0, current_date - c.fecha_vencimiento) as dias_vencido
     from compra c join empresa e on e.id = c.empresa_id join tercero t on t.id = c.proveedor_id
     ${where}
     order by c.fecha_vencimiento nulls last, c.fecha`,
    params
  );
  res.json(rows);
});

router.get('/proveedores/:terceroId/documentos', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [req.params.terceroId];
  let where = 'where c.proveedor_id = $1';
  if (empresa_id) { params.push(empresa_id); where += ` and c.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select c.id, c.clase, c.descripcion, c.numero_factura_proveedor, c.fecha, c.fecha_vencimiento, c.total, c.saldo, c.forma_pago, e.nombre as empresa,
            greatest(0, current_date - c.fecha_vencimiento) as dias_vencido
     from compra c join empresa e on e.id = c.empresa_id
     ${where}
     order by c.saldo > 0 desc, c.fecha_vencimiento nulls last, c.fecha
     limit 300`,
    params
  );
  res.json(rows);
});

// body: { empresa_id, tercero_id, fecha, medio_pago, notas, aplicaciones: [{ compra_id, valor }] }
router.post('/pagos', async (req, res) => {
  const { empresa_id, tercero_id, fecha, medio_pago, notas, aplicaciones } = req.body;
  if (!empresa_id || !tercero_id || !Array.isArray(aplicaciones) || aplicaciones.length === 0) {
    return res.status(400).json({ error: 'Faltan empresa_id, tercero_id o aplicaciones' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    let total = 0;
    for (const a of aplicaciones) {
      const valor = Number(a.valor);
      if (!(valor > 0)) throw new Error('Cada aplicación debe tener un valor mayor que cero');
      const { rows } = await client.query('select numero_factura_proveedor, saldo, proveedor_id, empresa_id from compra where id = $1 for update', [a.compra_id]);
      const c = rows[0];
      if (!c) throw new Error('Compra no encontrada');
      if (c.proveedor_id !== tercero_id) throw new Error('La compra no es de este proveedor');
      if (c.empresa_id !== empresa_id) throw new Error('La compra es de otra empresa');
      if (valor > Number(c.saldo) + 0.005) throw new Error(`El valor supera el saldo de la compra ${c.numero_factura_proveedor || ''} (${c.saldo})`);
      total += valor;
    }
    const pago = await registrarEgreso(client, {
      empresa_id, tercero_id, fecha, medio_pago: medio_pago || 'transferencia', cuenta_pago_id: req.body.cuenta_pago_id,
      referencia: req.body.referencia, notas, aplicaciones, creado_por: req.usuario?.sub,
    });
    for (const a of aplicaciones) {
      await client.query('update compra set saldo = round(saldo - $1, 2) where id = $2', [Number(a.valor), a.compra_id]);
    }
    await client.query('commit');
    await contabilizar('pago_proveedor', pago.id);
    res.status(201).json({ id: pago.id, consecutivo: pago.consecutivo, total, cuenta: pago.cuenta });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/pagos', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = '';
  if (empresa_id) { params.push(empresa_id); where = 'where p.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select p.id, p.estado, p.motivo_anulacion, p.consecutivo, p.fecha, p.medio_pago, p.referencia, p.total, p.notas, e.nombre as empresa, t.nombre as proveedor,
            cp.nombre as cuenta_pago,
            (select string_agg(coalesce(c.numero_factura_proveedor, to_char(c.fecha, 'YYYY-MM-DD')), ', ')
               from pago_proveedor_aplicacion a join compra c on c.id = a.compra_id where a.pago_proveedor_id = p.id) as compras
     from pago_proveedor p join empresa e on e.id = p.empresa_id join tercero t on t.id = p.tercero_id
     left join cuenta_pago cp on cp.id = p.cuenta_pago_id
     ${where} order by p.fecha desc, p.creado_en desc limit 200`,
    params
  );
  res.json(rows);
});

// Comprobante de egreso (para imprimir): encabezado, documentos pagados con
// sus retenciones e imputación contable.
router.get('/pagos/:id/comprobante', async (req, res) => {
  const { rows } = await pool.query(
    `select p.*, e.nombre as empresa, e.nit as empresa_nit, t.nombre as beneficiario, t.tipo_documento, t.numero_documento,
            t.direccion, t.telefono, cp.nombre as cuenta_pago, cp.tipo as cuenta_tipo, cp.banco, cp.numero as cuenta_numero,
            u.nombre as elaborado_por
     from pago_proveedor p join empresa e on e.id = p.empresa_id join tercero t on t.id = p.tercero_id
     left join cuenta_pago cp on cp.id = p.cuenta_pago_id left join usuario u on u.id = p.creado_por
     where p.id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Egreso no encontrado' });
  const { rows: docs } = await pool.query(
    `select c.id, c.clase, c.numero_factura_proveedor, c.fecha, c.descripcion, c.subtotal, c.iva, c.retefuente, c.reteiva, c.reteica,
            c.total, c.saldo, a.valor as pagado,
            (select string_agg(distinct coalesce(gi.descripcion, gi.categoria), ', ') from gasto_item gi where gi.compra_id = c.id) as detalle_gasto
     from pago_proveedor_aplicacion a join compra c on c.id = a.compra_id where a.pago_proveedor_id = $1 order by c.fecha`, [req.params.id]
  );
  const { rows: asiento } = await pool.query(
    `select l.cuenta, cu.nombre, l.debito, l.credito from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta cu on cu.codigo = l.cuenta
     where a.origen = 'pago_proveedor' and a.origen_id = $1 order by l.debito desc`, [req.params.id]
  );
  res.json({ ...rows[0], documentos: docs, asiento });
});

// ------------------------------------------------------------- resumen
router.get('/resumen', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let wf = "where estado = 'vigente'";
  let wc = 'where true';
  if (empresa_id) { params.push(empresa_id); wf += ' and empresa_id = $1'; wc += ' and empresa_id = $1'; }
  const [cxc, cxp] = await Promise.all([
    pool.query(`select coalesce(sum(saldo),0) as saldo, coalesce(sum(case when fecha_vencimiento < current_date then saldo else 0 end),0) as vencido from factura_venta ${wf}`, params),
    pool.query(`select coalesce(sum(saldo),0) as saldo, coalesce(sum(case when fecha_vencimiento < current_date then saldo else 0 end),0) as vencido from compra ${wc}`, params),
  ]);
  res.json({ por_cobrar: cxc.rows[0], por_pagar: cxp.rows[0] });
});

router.post('/recibos/:id/anular', requireRole('admin'), async (req, res) => {
  try {
    res.json(await anularRecibo(req.params.id, req.body?.motivo, req.usuario?.sub));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.post('/pagos/:id/anular', requireRole('admin'), async (req, res) => {
  try {
    res.json(await anularEgreso(req.params.id, req.body?.motivo, req.usuario?.sub));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
