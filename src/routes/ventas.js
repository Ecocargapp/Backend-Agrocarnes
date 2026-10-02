import { Router } from 'express';
import { pool } from '../db/pool.js';
import { registrarMovimiento } from '../db/inventario.js';
import { emitidaElectronicamente } from './notas-credito.js';
import { descargarPdf } from '../dian/facturas-factus.js';
import { enviarFacturaADian, sincronizarEstado } from '../dian/cliente.js';

export const router = Router();

// Vende al cliente final (mostrador Agrocarnes o consumo del Restaurante).
// body: { empresa_id, cliente_id, bodega_id, items: [{producto_id, cantidad, precio_unitario}] }
router.post('/', async (req, res) => {
  const { empresa_id, cliente_id, bodega_id, items, forma_pago = 'contado', dias_plazo, fecha_vencimiento, medio_pago } = req.body;
  const ventaInterna = req.body.venta_interna === true || req.body.venta_interna === 'true';
  if (!empresa_id || !bodega_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Faltan empresa_id, bodega_id o items' });
  }
  if (!['contado', 'credito'].includes(forma_pago)) return res.status(400).json({ error: 'forma_pago debe ser contado o credito' });
  if (forma_pago === 'credito' && !cliente_id) return res.status(400).json({ error: 'Una venta a crédito necesita un cliente identificado' });

  const client = await pool.connect();
  let facturaId;
  let consecutivo;
  try {
    await client.query('begin');

    // Consecutivo por empresa (bloqueando la fila para que no se repita).
    const { rows: empRows } = await client.query(
      `update empresa set ultimo_consecutivo = ultimo_consecutivo + 1
       where id = $1 returning prefijo_factura, ultimo_consecutivo`,
      [empresa_id]
    );
    if (!empRows[0]) throw new Error('Empresa no encontrada');
    consecutivo = `${empRows[0].prefijo_factura || 'FV'}-${String(empRows[0].ultimo_consecutivo).padStart(6, '0')}`;

    const total = items.reduce((acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario), 0);
    let vencimiento = null;
    if (forma_pago === 'credito') {
      vencimiento = fecha_vencimiento || new Date(Date.now() + (Number(dias_plazo) || 30) * 864e5).toISOString().slice(0, 10);
    }
    const { rows: facturaRows } = await client.query(
      `insert into factura_venta (empresa_id, cliente_id, consecutivo, total, forma_pago, fecha_vencimiento, saldo, creado_por, venta_interna, estado_dian)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [empresa_id, cliente_id || null, consecutivo, total, forma_pago, vencimiento, total, req.usuario?.sub, ventaInterna, ventaInterna ? 'no_aplica' : 'pendiente']
    );
    facturaId = facturaRows[0].id;

    if (forma_pago === 'contado') {
      // Venta de contado: se registra el cobro de inmediato para que la cartera cuadre.
      const { rows: emp } = await client.query('update empresa set ultimo_recibo = ultimo_recibo + 1 where id = $1 returning ultimo_recibo', [empresa_id]);
      const { rows: rec } = await client.query(
        `insert into recibo_caja (empresa_id, tercero_id, consecutivo, medio_pago, total, notas, creado_por)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [empresa_id, cliente_id || null, emp[0].ultimo_recibo, medio_pago || 'efectivo', total, `Venta de contado ${consecutivo}`, req.usuario?.sub]
      );
      await client.query('insert into recibo_caja_aplicacion (recibo_caja_id, factura_venta_id, valor) values ($1, $2, $3)', [rec[0].id, facturaId, total]);
      await client.query('update factura_venta set saldo = 0 where id = $1', [facturaId]);
    }

    for (const item of items) {
      await client.query(
        `insert into factura_venta_item (factura_venta_id, producto_id, cantidad, precio_unitario)
         values ($1, $2, $3, $4)`,
        [facturaId, item.producto_id, item.cantidad, item.precio_unitario]
      );

      // Platos del restaurante y servicios: se facturan pero no mueven inventario.
      const { rows: prodRows } = await client.query('select maneja_inventario from producto where id = $1', [item.producto_id]);
      if (!prodRows[0]) throw new Error('Producto no encontrado');
      if (prodRows[0].maneja_inventario === false) continue;

      const { rows: existRows } = await client.query(
        'select costo_promedio from existencia where bodega_id = $1 and producto_id = $2',
        [bodega_id, item.producto_id]
      );
      const costoUnitario = existRows[0]?.costo_promedio ?? 0;

      await registrarMovimiento(client, {
        tipo: 'venta', producto_id: item.producto_id, bodega_id, cantidad: item.cantidad, costo_unitario: costoUnitario,
        referencia_tipo: 'factura_venta', referencia_id: facturaId, creado_por: req.usuario?.sub,
      });
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }

  // La venta ya quedó registrada y el cliente puede recibir su recibo YA:
  // el envío a la DIAN pasa en segundo plano y no debe bloquear la venta.
  // Una venta interna (misma razón social) nunca va a la DIAN.
  if (!ventaInterna) {
    enviarFacturaADian(facturaId).catch((err) => {
      console.error(`No se pudo enviar la factura ${facturaId} a la DIAN:`, err.message);
    });
  }

  res.status(201).json({ id: facturaId, consecutivo });
});

router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = '';
  if (empresa_id) { params.push(empresa_id); where = 'where f.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select f.id, f.consecutivo, f.fecha, f.total, f.estado_dian, f.venta_interna, f.cufe, f.dian_mensaje, f.arco_factura_id, f.forma_pago, f.fecha_vencimiento, f.saldo, f.estado,
            e.nombre as empresa, t.nombre as cliente,
            (select count(*)::int from factura_venta_item i where i.factura_venta_id = f.id) as items
     from factura_venta f
     join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id
     ${where}
     order by f.fecha desc limit 200`,
    params
  );
  res.json(rows);
});

// Informe de venta diaria: cada factura con su forma de pago y el medio de
// pago con el que se cobró (de contado, inmediato; a crédito, el usado en
// los recibos que se le hayan aplicado hasta la fecha; vacío si sigue
// pendiente). Pensado para exportarse a Excel desde el frontend.
// query: empresa_id, desde, hasta (YYYY-MM-DD, por defecto hoy)
router.get('/reporte-diario', async (req, res) => {
  const { empresa_id } = req.query;
  const desde = req.query.desde || new Date().toISOString().slice(0, 10);
  const hasta = req.query.hasta || desde;
  const params = [desde, hasta];
  let where = 'where f.fecha::date between $1 and $2';
  if (empresa_id) { params.push(empresa_id); where += ` and f.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select f.id, f.fecha, f.consecutivo, f.forma_pago, f.total, f.saldo, f.estado, f.estado_dian,
            e.nombre as empresa, coalesce(t.nombre, 'Consumidor final') as cliente,
            (select string_agg(distinct r.medio_pago, ', ' order by r.medio_pago)
               from recibo_caja_aplicacion a join recibo_caja r on r.id = a.recibo_caja_id
              where a.factura_venta_id = f.id) as medio_pago
     from factura_venta f
     join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id
     ${where}
     order by f.fecha`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select f.*, e.nombre as empresa, t.nombre as cliente
     from factura_venta f join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id where f.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
  const { rows: items } = await pool.query(
    `select i.producto_id, i.cantidad, i.precio_unitario, coalesce(p.codigo || ' · ', '') || p.nombre as producto, p.unidad_medida
     from factura_venta_item i join producto p on p.id = i.producto_id
     where i.factura_venta_id = $1 order by p.nombre`,
    [req.params.id]
  );
  res.json({ ...rows[0], items });
});

// Reintenta el envío a la DIAN (o refresca el estado si ya está en Arco).
router.post('/:id/dian', async (req, res) => {
  try {
    const { rows } = await pool.query('select venta_interna from factura_venta where id = $1', [req.params.id]);
    if (rows[0]?.venta_interna) return res.status(400).json({ error: 'Es una venta interna (misma razón social): no se envía a la DIAN' });
    const r = await enviarFacturaADian(req.params.id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PDF de la factura electrónica (representación gráfica) para imprimir.
router.get('/:id/pdf', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select e.proveedor_dian from factura_venta f join empresa e on e.id = f.empresa_id where f.id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    if (rows[0].proveedor_dian !== 'factus') return res.status(400).json({ error: 'El PDF solo está disponible para facturas emitidas con Factus' });
    const { nombre, buffer } = await descargarPdf(req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${nombre.replace(/"/g, '')}"` });
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/dian/estado', async (req, res) => {
  try {
    res.json(await sincronizarEstado(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Anula una factura. Si aún no está en Arco, se revierte directamente; si ya
// fue emitida electrónicamente, la anulación se hace con nota crédito (razón 2)
// desde /notas-credito con anulacion=true. Esta ruta cubre el primer caso y
// delega el segundo.
router.post('/:id/anular', async (req, res) => {
  const { motivo } = req.body || {};
  if (!motivo) return res.status(400).json({ error: 'Indica el motivo de la anulación' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query('select * from factura_venta where id = $1 for update', [req.params.id]);
    const f = rows[0];
    if (!f) throw new Error('Factura no encontrada');
    if (f.estado !== 'vigente') throw new Error('La factura ya está anulada');
    if (emitidaElectronicamente(f)) throw new Error('La factura ya fue emitida electrónicamente: anúlala con una nota crédito de anulación (razón 2)');
    const { rows: cobrado } = await client.query('select coalesce(sum(valor),0) as v from recibo_caja_aplicacion where factura_venta_id = $1', [f.id]);
    if (Number(cobrado[0].v) > 0 && f.forma_pago === 'credito') {
      throw new Error('La factura tiene cobros aplicados; registra primero la devolución del dinero o usa nota crédito');
    }

    // Reingresar el inventario que salió con la venta, al costo con el que salió.
    const { rows: movs } = await client.query(
      `select producto_id, bodega_id, cantidad, costo_unitario from movimiento_inventario
       where referencia_tipo = 'factura_venta' and referencia_id = $1 and tipo = 'venta'`, [f.id]
    );
    for (const m of movs) {
      await registrarMovimiento(client, {
        tipo: 'anulacion_venta', producto_id: m.producto_id, bodega_id: m.bodega_id, cantidad: m.cantidad, costo_unitario: m.costo_unitario,
        referencia_tipo: 'factura_venta', referencia_id: f.id, creado_por: req.usuario?.sub,
      });
    }
    await client.query(
      `update factura_venta set estado = 'anulada', saldo = 0, estado_dian = 'anulada', anulada_en = now(), anulada_por = $2, motivo_anulacion = $3 where id = $1`,
      [f.id, req.usuario?.sub, motivo]
    );
    await client.query('commit');
    res.json({ ok: true, estado: 'anulada' });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});
