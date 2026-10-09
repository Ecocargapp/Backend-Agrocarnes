import { requireRole } from '../middleware/auth.js';
// Notas crédito sobre facturas de venta.
//
// Razones (códigos DIAN, los mismos que usa Arco):
//   1 devolución parcial / no aceptación parcial   → normalmente reingresa inventario
//   2 anulación de factura electrónica             → total, reingresa inventario, deja la factura anulada
//   3 rebaja o descuento parcial o total           → no mueve inventario
//   4 ajuste de precio                             → no mueve inventario
//   5 descuento comercial por pronto pago          → no mueve inventario
//   6 descuento comercial por volumen              → no mueve inventario
//
// Efectos locales (en una transacción): nota_credito + ítems, reingreso de
// inventario si aplica (al costo con el que salió la venta), reducción del
// saldo por cobrar de la factura. Después, en segundo plano, se envía a Arco
// (dian/notas.js) si la factura fue emitida electrónicamente.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { registrarMovimiento } from '../db/inventario.js';
import { contabilizar } from '../contabilidad/contabilizar.js';
import { enviarNotaCreditoADian, sincronizarNotaCredito } from '../dian/notas.js';

export const router = Router();

// Emitida ante la DIAN por Arco (arco_factura_id) o por Factus (CUFE / enviada).
export function emitidaElectronicamente(f) {
  return Boolean(f.arco_factura_id || f.cufe || ['enviada', 'aceptada'].includes(f.estado_dian));
}

const RAZONES = { 1: 'Devolución parcial', 2: 'Anulación de factura', 3: 'Rebaja o descuento', 4: 'Ajuste de precio', 5: 'Descuento pronto pago', 6: 'Descuento por volumen' };

// body: { factura_venta_id, razon, items: [{producto_id, cantidad, precio_unitario}], reingresa_inventario, bodega_id, notas, anulacion }
// Si anulacion=true (o razon=2) se toman todos los ítems de la factura y se anula.
router.post('/', requireRole('admin'), async (req, res) => {
  const { factura_venta_id, notas } = req.body;
  let { razon, items, reingresa_inventario, bodega_id, anulacion } = req.body;
  razon = Number(razon);
  if (anulacion) razon = 2; // anulacion=true no necesita razon explícita
  if (!factura_venta_id || !RAZONES[razon]) return res.status(400).json({ error: 'Faltan factura_venta_id o razón válida (1-6)' });
  if (razon === 2) anulacion = true;

  const client = await pool.connect();
  let notaId;
  try {
    await client.query('begin');
    const { rows } = await client.query('select * from factura_venta where id = $1 for update', [factura_venta_id]);
    const f = rows[0];
    if (!f) throw new Error('Factura no encontrada');
    if (f.estado !== 'vigente') throw new Error('La factura ya está anulada');

    const { rows: itemsFactura } = await client.query(
      `select i.producto_id, i.cantidad, i.precio_unitario, m.bodega_id, m.costo_unitario
       from factura_venta_item i
       left join lateral (
         select bodega_id, costo_unitario from movimiento_inventario
         where referencia_tipo = 'factura_venta' and referencia_id = i.factura_venta_id and producto_id = i.producto_id and tipo = 'venta'
         order by creado_en limit 1
       ) m on true
       where i.factura_venta_id = $1`,
      [factura_venta_id]
    );

    if (anulacion) {
      items = itemsFactura.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad, precio_unitario: i.precio_unitario }));
      reingresa_inventario = reingresa_inventario !== false;
      razon = 2;
    }
    if (!Array.isArray(items) || items.length === 0) throw new Error('La nota crédito necesita al menos un ítem');

    // Validar contra lo facturado (no se puede devolver más de lo vendido, contando NC anteriores).
    const { rows: yaDevuelto } = await client.query(
      `select i.producto_id, sum(i.cantidad) as cantidad from nota_credito_item i join nota_credito n on n.id = i.nota_credito_id
       where n.factura_venta_id = $1 group by i.producto_id`, [factura_venta_id]
    );
    const devuelto = Object.fromEntries(yaDevuelto.map((r) => [r.producto_id, Number(r.cantidad)]));
    for (const it of items) {
      const orig = itemsFactura.find((x) => x.producto_id === it.producto_id);
      if (!orig) throw new Error('Un ítem de la nota no pertenece a la factura');
      if (!(Number(it.cantidad) > 0)) throw new Error('Cantidad inválida en la nota crédito');
      if (Number(it.cantidad) + (devuelto[it.producto_id] || 0) > Number(orig.cantidad) + 1e-9) {
        throw new Error('La cantidad supera lo facturado (descontando notas anteriores)');
      }
    }

    const total = items.reduce((a, i) => a + Number(i.cantidad) * Number(i.precio_unitario), 0);
    const { rows: emp } = await client.query(
      'update empresa set ultimo_nota_credito = ultimo_nota_credito + 1 where id = $1 returning prefijo_factura, ultimo_nota_credito', [f.empresa_id]
    );
    const consecutivo = `NC-${emp[0].prefijo_factura || 'FV'}-${String(emp[0].ultimo_nota_credito).padStart(6, '0')}`;
    const bodegaDestino = bodega_id || itemsFactura[0]?.bodega_id;

    const { rows: nc } = await client.query(
      `insert into nota_credito (empresa_id, factura_venta_id, consecutivo, razon, reingresa_inventario, bodega_id, total, notas, estado_dian, creado_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [f.empresa_id, f.id, consecutivo, razon, Boolean(reingresa_inventario), reingresa_inventario ? bodegaDestino : null, total, notas || null,
       emitidaElectronicamente(f) ? 'pendiente' : 'no_aplica', req.usuario?.sub]
    );
    notaId = nc[0].id;

    for (const it of items) {
      await client.query(
        'insert into nota_credito_item (nota_credito_id, producto_id, cantidad, precio_unitario) values ($1, $2, $3, $4)',
        [notaId, it.producto_id, it.cantidad, it.precio_unitario]
      );
      if (reingresa_inventario) {
        const orig = itemsFactura.find((x) => x.producto_id === it.producto_id);
        await registrarMovimiento(client, {
          tipo: anulacion ? 'anulacion_venta' : 'devolucion_venta',
          producto_id: it.producto_id, bodega_id: bodegaDestino, cantidad: it.cantidad,
          costo_unitario: orig?.costo_unitario ?? 0,
          referencia_tipo: 'nota_credito', referencia_id: notaId, creado_por: req.usuario?.sub,
        });
      }
    }

    // Cartera: la nota reduce lo que el cliente debe. Si ya había pagado, queda a favor (se informa).
    const nuevoSaldo = Math.max(0, Number(f.saldo) - total);
    const saldoAFavor = Math.max(0, total - Number(f.saldo));
    await client.query('update factura_venta set saldo = $1 where id = $2', [nuevoSaldo, f.id]);
    if (anulacion) {
      await client.query(
        `update factura_venta set estado = 'anulada', saldo = 0, anulada_en = now(), anulada_por = $2, motivo_anulacion = $3 where id = $1`,
        [f.id, req.usuario?.sub, notas || 'Anulación por nota crédito']
      );
    }
    await client.query('commit');
    await contabilizar('nota_credito', notaId);

    if (emitidaElectronicamente(f)) {
      enviarNotaCreditoADian(notaId).catch((err) => console.error(`NC ${notaId} a la DIAN:`, err.message));
    }
    res.status(201).json({ id: notaId, consecutivo, total, saldo_a_favor: saldoAFavor, anulacion: Boolean(anulacion) });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const { empresa_id, factura_venta_id } = req.query;
  const params = [];
  const cond = [];
  if (empresa_id) { params.push(empresa_id); cond.push(`n.empresa_id = $${params.length}`); }
  if (factura_venta_id) { params.push(factura_venta_id); cond.push(`n.factura_venta_id = $${params.length}`); }
  const where = cond.length ? `where ${cond.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select n.id, n.consecutivo, n.fecha, n.razon, n.total, n.reingresa_inventario, n.estado_dian, n.cufe, n.dian_mensaje, n.arco_nota_id, n.notas,
            f.consecutivo as factura, e.nombre as empresa, coalesce(t.nombre, 'Consumidor final') as cliente
     from nota_credito n join factura_venta f on f.id = n.factura_venta_id
     join empresa e on e.id = n.empresa_id left join tercero t on t.id = f.cliente_id
     ${where} order by n.fecha desc limit 200`,
    params
  );
  res.json(rows.map((r) => ({ ...r, razon_texto: RAZONES[r.razon] })));
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select n.*, f.consecutivo as factura, e.nombre as empresa from nota_credito n
     join factura_venta f on f.id = n.factura_venta_id join empresa e on e.id = n.empresa_id where n.id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Nota crédito no encontrada' });
  const { rows: items } = await pool.query(
    `select i.cantidad, i.precio_unitario, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida from nota_credito_item i join producto p on p.id = i.producto_id where i.nota_credito_id = $1`,
    [req.params.id]
  );
  res.json({ ...rows[0], razon_texto: RAZONES[rows[0].razon], items });
});

router.post('/:id/dian', async (req, res) => {
  try { res.json(await enviarNotaCreditoADian(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/:id/dian/estado', async (req, res) => {
  try { res.json(await sincronizarNotaCredito(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
