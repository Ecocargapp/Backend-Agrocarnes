// Anulación de documentos. Reglas comunes:
//  - El documento no se borra: queda con estado 'anulado' (o 'anulada'), motivo,
//    usuario y fecha, y una línea en la bitácora `anulacion`.
//  - Se reversa todo lo que el documento movió: inventario (con movimientos
//    anulacion_entrada / anulacion_salida), saldos de cartera y contabilidad
//    (el asiento se elimina al recontabilizar).
//  - Si otro documento vigente depende de éste, se pide anular ese primero
//    (ej. una compra pagada con un egreso que también pagó otras compras).
//    Los cobros/pagos automáticos de contado (que solo cubren este documento)
//    se anulan en cascada.
//  - Facturas emitidas ante la DIAN no se anulan aquí: se anulan con nota
//    crédito (ver routes/notas-credito.js).
import { pool } from '../db/pool.js';
import { registrarMovimiento, TIPOS_ENTRADA } from '../db/inventario.js';
import { contabilizar } from './contabilizar.js';

const REVERSOS = new Set(['anulacion_entrada', 'anulacion_salida', 'anulacion_venta', 'devolucion_venta']);

// Reversa todos los movimientos de inventario de un documento. Primero saca lo
// que entró (puede fallar si ya se vendió o se consumió) y luego devuelve lo
// que salió.
export async function reversarInventario(client, referenciaTipo, id, usuario) {
  const { rows } = await client.query(
    `select m.*, p.nombre as producto, b.nombre as bodega from movimiento_inventario m
     join producto p on p.id = m.producto_id join bodega b on b.id = m.bodega_id
     where m.referencia_tipo = $1 and m.referencia_id = $2 order by m.creado_en`, [referenciaTipo, id]
  );
  const originales = rows.filter((m) => !REVERSOS.has(m.tipo));
  const entradas = originales.filter((m) => TIPOS_ENTRADA.has(m.tipo));
  const salidas = originales.filter((m) => !TIPOS_ENTRADA.has(m.tipo));
  for (const m of entradas) {
    try {
      await registrarMovimiento(client, {
        tipo: 'anulacion_entrada', producto_id: m.producto_id, bodega_id: m.bodega_id, cantidad: m.cantidad, costo_unitario: m.costo_unitario,
        referencia_tipo: referenciaTipo, referencia_id: id, creado_por: usuario,
      });
    } catch (err) {
      if (/suficiente existencia/.test(err.message)) {
        const { rows: ex } = await client.query('select cantidad from existencia where bodega_id = $1 and producto_id = $2', [m.bodega_id, m.producto_id]);
        throw new Error(`No se puede anular: de "${m.producto}" entraron ${Number(m.cantidad)} a ${m.bodega} y hoy solo quedan ${Number(ex[0]?.cantidad || 0)} (ya se vendió o se usó). Registra primero la devolución o ajusta el inventario.`);
      }
      throw err;
    }
  }
  for (const m of salidas) {
    await registrarMovimiento(client, {
      tipo: 'anulacion_salida', producto_id: m.producto_id, bodega_id: m.bodega_id, cantidad: m.cantidad, costo_unitario: m.costo_unitario,
      referencia_tipo: referenciaTipo, referencia_id: id, creado_por: usuario,
    });
  }
  return originales.length;
}

async function bitacora(client, { documento, documento_id, empresa_id, descripcion, motivo, detalle, usuario }) {
  await client.query(
    `insert into anulacion (documento, documento_id, empresa_id, descripcion, motivo, detalle, usuario_id) values ($1, $2, $3, $4, $5, $6, $7)`,
    [documento, documento_id, empresa_id, descripcion, motivo, detalle || null, usuario || null]
  );
}

async function transaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await fn(client);
    await client.query('commit');
    return r;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

const exigirMotivo = (motivo) => {
  if (!motivo || String(motivo).trim().length < 5) throw new Error('Escribe el motivo de la anulación (mínimo 5 caracteres)');
  return String(motivo).trim();
};

// ------------------------------------------------------- recibos de caja
async function anularReciboTx(client, id, motivo, usuario, { cascada = false } = {}) {
  const { rows } = await client.query('select * from recibo_caja where id = $1 for update', [id]);
  const r = rows[0];
  if (!r) throw new Error('Recibo no encontrado');
  if (r.estado === 'anulado') throw new Error(`El recibo N.° ${r.consecutivo} ya está anulado`);
  const { rows: ap } = await client.query(
    `select a.factura_venta_id, a.valor, f.consecutivo, f.estado from recibo_caja_aplicacion a join factura_venta f on f.id = a.factura_venta_id where a.recibo_caja_id = $1`, [id]
  );
  for (const a of ap) {
    if (a.estado === 'anulada') continue; // la factura ya está anulada: su saldo queda en 0
    await client.query('update factura_venta set saldo = round(saldo + $1, 2) where id = $2', [Number(a.valor), a.factura_venta_id]);
  }
  await client.query(
    `update recibo_caja set estado = 'anulado', anulado_en = now(), anulado_por = $2, motivo_anulacion = $3 where id = $1`, [id, usuario, motivo]
  );
  await bitacora(client, {
    documento: 'recibo_caja', documento_id: id, empresa_id: r.empresa_id, motivo, usuario,
    descripcion: `Recibo de caja N.° ${r.consecutivo} por ${r.total}${cascada ? ' (en cascada)' : ''}`,
    detalle: { facturas: ap.map((a) => ({ consecutivo: a.consecutivo, valor: Number(a.valor) })) },
  });
  return r;
}

export async function anularRecibo(id, motivo, usuario) {
  motivo = exigirMotivo(motivo);
  const r = await transaccion((c) => anularReciboTx(c, id, motivo, usuario));
  await contabilizar('recibo_caja', id);
  return { ok: true, documento: `Recibo N.° ${r.consecutivo}` };
}

// ------------------------------------------------- comprobantes de egreso
async function anularEgresoTx(client, id, motivo, usuario, { cascada = false } = {}) {
  const { rows } = await client.query('select * from pago_proveedor where id = $1 for update', [id]);
  const p = rows[0];
  if (!p) throw new Error('Egreso no encontrado');
  if (p.estado === 'anulado') throw new Error(`El comprobante de egreso N.° ${p.consecutivo} ya está anulado`);
  const { rows: ap } = await client.query(
    `select a.compra_id, a.valor, c.numero_factura_proveedor, c.estado from pago_proveedor_aplicacion a join compra c on c.id = a.compra_id where a.pago_proveedor_id = $1`, [id]
  );
  for (const a of ap) {
    if (a.estado === 'anulado') continue;
    await client.query('update compra set saldo = round(saldo + $1, 2) where id = $2', [Number(a.valor), a.compra_id]);
  }
  await client.query(
    `update pago_proveedor set estado = 'anulado', anulado_en = now(), anulado_por = $2, motivo_anulacion = $3 where id = $1`, [id, usuario, motivo]
  );
  await bitacora(client, {
    documento: 'pago_proveedor', documento_id: id, empresa_id: p.empresa_id, motivo, usuario,
    descripcion: `Comprobante de egreso N.° ${p.consecutivo} por ${p.total}${cascada ? ' (en cascada)' : ''}`,
    detalle: { documentos: ap.map((a) => ({ factura: a.numero_factura_proveedor, valor: Number(a.valor) })) },
  });
  return p;
}

export async function anularEgreso(id, motivo, usuario) {
  motivo = exigirMotivo(motivo);
  const p = await transaccion((c) => anularEgresoTx(c, id, motivo, usuario));
  await contabilizar('pago_proveedor', id);
  return { ok: true, documento: `Comprobante de egreso N.° ${p.consecutivo}` };
}

// ------------------------------------------------------- compras y gastos
export async function anularCompra(id, motivo, usuario) {
  motivo = exigirMotivo(motivo);
  const egresosAnulados = [];
  const c = await transaccion(async (client) => {
    const { rows } = await client.query('select * from compra where id = $1 for update', [id]);
    const c = rows[0];
    if (!c) throw new Error('Documento no encontrado');
    if (c.estado === 'anulado') throw new Error('El documento ya está anulado');
    const nombre = `${c.clase === 'gasto' ? 'Gasto' : 'Compra'} ${c.numero_factura_proveedor || ''}`.trim();
    // Egresos vigentes que pagaron este documento.
    const { rows: pagos } = await client.query(
      `select p.id, p.consecutivo, (select count(*)::int from pago_proveedor_aplicacion x where x.pago_proveedor_id = p.id) as documentos
       from pago_proveedor p join pago_proveedor_aplicacion a on a.pago_proveedor_id = p.id
       where a.compra_id = $1 and p.estado <> 'anulado'`, [id]
    );
    const compartidos = pagos.filter((p) => p.documentos > 1);
    if (compartidos.length) {
      throw new Error(`Este documento se pagó con el comprobante de egreso N.° ${compartidos.map((p) => p.consecutivo).join(', ')}, que también pagó otros documentos. Anula primero ese egreso (Cartera → Por pagar).`);
    }
    for (const p of pagos) {
      await anularEgresoTx(client, p.id, `${motivo} (anulación de ${nombre})`, usuario, { cascada: true });
      egresosAnulados.push(p.id);
    }
    const movs = await reversarInventario(client, 'compra', id, usuario);
    if (c.clase === 'gasto') {
      await client.query(`update activo_fijo set activo = false where gasto_item_id in (select id from gasto_item where compra_id = $1)`, [id]);
      await client.query(
        `delete from asiento where origen = 'depreciacion' and origen_id in (select a.id from activo_fijo a join gasto_item g on g.id = a.gasto_item_id where g.compra_id = $1)`, [id]
      );
    }
    await client.query(
      `update compra set estado = 'anulado', saldo = 0, anulado_en = now(), anulado_por = $2, motivo_anulacion = $3 where id = $1`, [id, usuario, motivo]
    );
    await bitacora(client, {
      documento: c.clase === 'gasto' ? 'gasto' : 'compra', documento_id: id, empresa_id: c.empresa_id, motivo, usuario,
      descripcion: `${nombre} por ${c.total}`, detalle: { movimientos_reversados: movs, egresos_anulados: pagos.map((p) => p.consecutivo) },
    });
    return c;
  });
  await contabilizar('compra', id);
  for (const e of egresosAnulados) await contabilizar('pago_proveedor', e);
  return { ok: true, documento: c.clase === 'gasto' ? 'Gasto' : 'Compra', egresos_anulados: egresosAnulados.length };
}

// ------------------------------------------------- facturas de venta (locales)
// Solo para facturas que NO se emitieron ante la DIAN (ventas internas,
// empresas sin facturación electrónica o envíos que nunca se hicieron).
export async function anularVentaLocal(id, motivo, usuario, emitidaElectronicamente) {
  motivo = exigirMotivo(motivo);
  const recibosAnulados = [];
  const f = await transaccion(async (client) => {
    const { rows } = await client.query('select * from factura_venta where id = $1 for update', [id]);
    const f = rows[0];
    if (!f) throw new Error('Factura no encontrada');
    if (f.estado !== 'vigente') throw new Error('La factura ya está anulada');
    if (emitidaElectronicamente(f)) throw new Error('La factura ya fue emitida ante la DIAN: se anula con una nota crédito de anulación');
    const { rows: recibos } = await client.query(
      `select r.id, r.consecutivo, (select count(*)::int from recibo_caja_aplicacion x where x.recibo_caja_id = r.id) as documentos
       from recibo_caja r join recibo_caja_aplicacion a on a.recibo_caja_id = r.id
       where a.factura_venta_id = $1 and r.estado <> 'anulado'`, [id]
    );
    const compartidos = recibos.filter((r) => r.documentos > 1);
    if (compartidos.length) {
      throw new Error(`La factura se cobró con el recibo N.° ${compartidos.map((r) => r.consecutivo).join(', ')}, que también cobró otras facturas. Anula primero ese recibo (Cartera → Por cobrar).`);
    }
    for (const r of recibos) {
      await anularReciboTx(client, r.id, `${motivo} (anulación de la factura ${f.consecutivo})`, usuario, { cascada: true });
      recibosAnulados.push(r.id);
    }
    await reversarInventario(client, 'factura_venta', id, usuario);
    await client.query(
      `update factura_venta set estado = 'anulada', saldo = 0, estado_dian = case when venta_interna then estado_dian else 'anulada' end,
              anulada_en = now(), anulada_por = $2, motivo_anulacion = $3 where id = $1`, [id, usuario, motivo]
    );
    await bitacora(client, {
      documento: 'factura_venta', documento_id: id, empresa_id: f.empresa_id, motivo, usuario,
      descripcion: `Factura ${f.consecutivo} por ${f.total}`, detalle: { recibos_anulados: recibos.map((r) => r.consecutivo) },
    });
    return f;
  });
  await contabilizar('factura_venta', id);
  for (const r of recibosAnulados) await contabilizar('recibo_caja', r);
  return { ok: true, documento: `Factura ${f.consecutivo}`, recibos_anulados: recibosAnulados.length };
}

// ------------------------------------------------------------------ traslados
export async function anularTraslado(id, motivo, usuario) {
  motivo = exigirMotivo(motivo);
  await transaccion(async (client) => {
    const { rows } = await client.query('select * from traslado where id = $1 for update', [id]);
    const t = rows[0];
    if (!t) throw new Error('Traslado no encontrado');
    if (t.estado === 'anulado') throw new Error('El traslado ya está anulado');
    await reversarInventario(client, 'traslado', id, usuario);
    await client.query(`update traslado set estado = 'anulado', anulado_en = now(), anulado_por = $2, motivo_anulacion = $3 where id = $1`, [id, usuario, motivo]);
    const { rows: b } = await client.query('select empresa_id from bodega where id = $1', [t.bodega_origen_id]);
    await bitacora(client, { documento: 'traslado', documento_id: id, empresa_id: b[0]?.empresa_id, motivo, usuario, descripcion: `Traslado de ${t.cantidad}` });
  });
  await contabilizar('traslado', id);
  return { ok: true, documento: 'Traslado' };
}

// ------------------------------------------------------ órdenes de producción
export async function anularProduccion(id, motivo, usuario) {
  motivo = exigirMotivo(motivo);
  await transaccion(async (client) => {
    const { rows } = await client.query('select * from orden_produccion where id = $1 for update', [id]);
    const o = rows[0];
    if (!o) throw new Error('Orden de producción no encontrada');
    if (o.estado === 'anulado') throw new Error('La orden ya está anulada');
    await reversarInventario(client, 'orden_produccion', id, usuario);
    await client.query(`update orden_produccion set estado = 'anulado', anulado_en = now(), anulado_por = $2, motivo_anulacion = $3 where id = $1`, [id, usuario, motivo]);
    await bitacora(client, { documento: 'orden_produccion', documento_id: id, empresa_id: o.empresa_id, motivo, usuario, descripcion: `Producción de ${o.cantidad_producida}` });
  });
  return { ok: true, documento: 'Orden de producción' };
}
