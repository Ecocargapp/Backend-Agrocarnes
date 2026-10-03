// Genera los asientos contables (PUC) a partir de los documentos del sistema.
//
// Cada documento produce un asiento cuadrado (débitos = créditos). Los
// asientos automáticos se pueden borrar y volver a generar en cualquier
// momento (reconstruirContabilidad), así nunca se desincronizan de los
// documentos. Los asientos manuales (origen = 'manual') no se tocan.
//
//   Venta          Dr 1305 clientes            Cr 4135 ventas, 240801 IVA, 249595 INC
//                  Dr 6135 costo de ventas     Cr 1435 inventario (al costo que salió)
//   Nota crédito   Dr 4175 devoluciones, IVA   Cr 1305 · reingreso: Dr 1435 Cr 6135
//   Compra (inv.)  Dr 1435, 240802 IVA desc.   Cr 2205 proveedores, 2365/2367/2368 retenciones
//   Gasto          Dr 51xx/52xx/53xx o 15xx    Cr 2335 costos y gastos por pagar, retenciones
//   Recibo de caja Dr 1105/1110, 1355 ret.     Cr 1305
//   Pago proveedor Dr 2205/2335                Cr 1105/1110
//   Traslado entre empresas (mismo NIT): origen Dr 2895 Cr 1435 · destino Dr 1435 Cr 2895
//   Depreciación   Dr 5160                     Cr 1592 (mensual, línea recta)

import { pool } from '../db/pool.js';
import { cuentaDisponible } from './catalogos.js';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

async function guardarAsiento(client, { empresa_id, fecha, origen, origen_id, periodo = null, descripcion, lineas }) {
  await client.query(
    `delete from asiento where origen = $1 and origen_id = $2 and coalesce(periodo, '') = coalesce($3, '')`,
    [origen, origen_id, periodo]
  );
  const ls = lineas
    .map((l) => ({ ...l, debito: r2(l.debito), credito: r2(l.credito) }))
    .filter((l) => l.debito > 0 || l.credito > 0);
  if (!ls.length) return null;
  const deb = r2(ls.reduce((a, l) => a + l.debito, 0));
  const cre = r2(ls.reduce((a, l) => a + l.credito, 0));
  if (Math.abs(deb - cre) > 0.009) throw new Error(`Asiento descuadrado (${origen} ${origen_id}): débitos ${deb} ≠ créditos ${cre}`);
  const { rows } = await client.query(
    `insert into asiento (empresa_id, fecha, origen, origen_id, periodo, descripcion) values ($1, $2, $3, $4, $5, $6) returning id`,
    [empresa_id, fecha, origen, origen_id, periodo, descripcion]
  );
  for (const l of ls) {
    await client.query(
      `insert into asiento_linea (asiento_id, cuenta, tercero_id, descripcion, debito, credito) values ($1, $2, $3, $4, $5, $6)`,
      [rows[0].id, l.cuenta, l.tercero_id || null, l.descripcion || null, l.debito, l.credito]
    );
  }
  return rows[0].id;
}

const borrar = (client, origen, id) => client.query('delete from asiento where origen = $1 and origen_id = $2', [origen, id]);

// Separa un valor con impuesto incluido en base + impuesto.
function separar(bruto, pct) {
  const b = r2(bruto);
  const imp = pct > 0 ? r2(b - b / (1 + pct / 100)) : 0;
  return { base: r2(b - imp), imp };
}

// Valor de los movimientos de inventario de un documento (cantidad × costo).
async function costoMovimientos(client, referenciaTipo, id, tipos) {
  const { rows } = await client.query(
    `select coalesce(sum(cantidad * costo_unitario), 0) as v from movimiento_inventario
     where referencia_tipo = $1 and referencia_id = $2 and tipo = any($3)`,
    [referenciaTipo, id, tipos]
  );
  return r2(rows[0].v);
}

// ------------------------------------------------------------------ ventas
export async function contabilizarVenta(client, id) {
  const { rows } = await client.query(
    `select f.*, (f.fecha at time zone 'America/Bogota')::date as dia from factura_venta f where f.id = $1`, [id]
  );
  const f = rows[0];
  if (!f) return;
  if (f.estado === 'anulada') {
    // Anulada localmente (sin nota crédito): la venta no existió. Si se anuló
    // con nota crédito, el asiento de la venta se conserva y la nota lo reversa.
    const { rows: nc } = await client.query('select 1 from nota_credito where factura_venta_id = $1 limit 1', [id]);
    if (!nc.length) return borrar(client, 'factura_venta', id);
  }
  const { rows: items } = await client.query(
    `select i.cantidad, i.precio_unitario, p.impuesto_pct, p.tipo_impuesto
     from factura_venta_item i join producto p on p.id = i.producto_id where i.factura_venta_id = $1`, [id]
  );
  let total = 0; let base = 0; let iva = 0; let inc = 0;
  for (const i of items) {
    const bruto = r2(Number(i.cantidad) * Number(i.precio_unitario));
    const s = separar(bruto, Number(i.impuesto_pct || 0));
    total += bruto; base += s.base;
    if (i.tipo_impuesto === 'INC') inc += s.imp; else iva += s.imp;
  }
  const costo = await costoMovimientos(client, 'factura_venta', id, ['venta']);
  const desc = `Factura ${f.consecutivo}${f.venta_interna ? ' (venta interna)' : ''}`;
  await guardarAsiento(client, {
    empresa_id: f.empresa_id, fecha: f.dia, origen: 'factura_venta', origen_id: id, descripcion: desc,
    lineas: [
      { cuenta: '1305', tercero_id: f.cliente_id, debito: total },
      { cuenta: '4135', credito: base },
      { cuenta: '240801', credito: iva },
      { cuenta: '249595', credito: inc },
      { cuenta: '6135', debito: costo, descripcion: 'Costo de lo vendido' },
      { cuenta: '1435', credito: costo, descripcion: 'Salida de inventario' },
    ],
  });
}

// ------------------------------------------------------------ notas crédito
export async function contabilizarNotaCredito(client, id) {
  const { rows } = await client.query(
    `select n.*, (n.fecha at time zone 'America/Bogota')::date as dia, f.cliente_id
     from nota_credito n join factura_venta f on f.id = n.factura_venta_id where n.id = $1`, [id]
  );
  const n = rows[0];
  if (!n) return;
  const { rows: items } = await client.query(
    `select i.cantidad, i.precio_unitario, p.impuesto_pct, p.tipo_impuesto
     from nota_credito_item i join producto p on p.id = i.producto_id where i.nota_credito_id = $1`, [id]
  );
  let total = 0; let base = 0; let iva = 0; let inc = 0;
  for (const i of items) {
    const bruto = r2(Number(i.cantidad) * Number(i.precio_unitario));
    const s = separar(bruto, Number(i.impuesto_pct || 0));
    total += bruto; base += s.base;
    if (i.tipo_impuesto === 'INC') inc += s.imp; else iva += s.imp;
  }
  const reingreso = await costoMovimientos(client, 'nota_credito', id, ['devolucion_venta', 'anulacion_venta']);
  await guardarAsiento(client, {
    empresa_id: n.empresa_id, fecha: n.dia, origen: 'nota_credito', origen_id: id, descripcion: `Nota crédito ${n.consecutivo}`,
    lineas: [
      { cuenta: '4175', debito: base },
      { cuenta: '240801', debito: iva },
      { cuenta: '249595', debito: inc },
      { cuenta: '1305', tercero_id: n.cliente_id, credito: total },
      { cuenta: '1435', debito: reingreso, descripcion: 'Reingreso de inventario' },
      { cuenta: '6135', credito: reingreso },
    ],
  });
}

// ------------------------------------------------------ compras y gastos
export async function contabilizarCompra(client, id) {
  const { rows } = await client.query('select * from compra where id = $1', [id]);
  const c = rows[0];
  if (!c) return;
  const lineas = [];
  const esGasto = c.clase === 'gasto';
  if (esGasto) {
    const { rows: items } = await client.query('select * from gasto_item where compra_id = $1', [id]);
    for (const i of items) {
      const ivaItem = r2(Number(i.valor) * Number(i.iva_pct) / 100);
      if (i.tipo === 'activo_fijo') {
        // El IVA del activo fijo se suma a su costo (no se descuenta en la declaración de IVA).
        lineas.push({ cuenta: i.cuenta, debito: r2(Number(i.valor) + ivaItem), descripcion: i.descripcion });
      } else {
        lineas.push({ cuenta: i.cuenta, debito: i.valor, descripcion: i.descripcion });
        lineas.push({ cuenta: '240802', debito: ivaItem, descripcion: 'IVA descontable' });
      }
    }
  } else {
    const { rows: items } = await client.query('select cantidad, costo_unitario, iva_pct from compra_item where compra_id = $1', [id]);
    let sub = 0; let iva = 0;
    for (const i of items) {
      const v = r2(Number(i.cantidad) * Number(i.costo_unitario));
      sub += v; iva += r2(v * Number(i.iva_pct || 0) / 100);
    }
    lineas.push({ cuenta: '1435', debito: sub, descripcion: 'Entrada de inventario' });
    lineas.push({ cuenta: '240802', debito: iva, descripcion: 'IVA descontable' });
  }
  const debitos = r2(lineas.reduce((a, l) => a + r2(l.debito), 0));
  const ret = { f: r2(c.retefuente), i: r2(c.reteiva), c: r2(c.reteica) };
  lineas.push({ cuenta: '2365', tercero_id: c.proveedor_id, credito: ret.f, descripcion: `Retención en la fuente (${c.concepto_retencion || ''})` });
  lineas.push({ cuenta: '2367', tercero_id: c.proveedor_id, credito: ret.i, descripcion: 'Retención de IVA' });
  lineas.push({ cuenta: '2368', tercero_id: c.proveedor_id, credito: ret.c, descripcion: 'Retención de ICA' });
  lineas.push({ cuenta: esGasto ? '2335' : '2205', tercero_id: c.proveedor_id, credito: r2(debitos - ret.f - ret.i - ret.c) });
  await guardarAsiento(client, {
    empresa_id: c.empresa_id, fecha: c.fecha, origen: 'compra', origen_id: id,
    descripcion: `${esGasto ? 'Gasto' : 'Compra'} ${c.numero_factura_proveedor || ''} ${c.descripcion || ''}`.trim(),
    lineas,
  });
}

// ----------------------------------------------------------- recibos de caja
export async function contabilizarRecibo(client, id) {
  const { rows } = await client.query('select * from recibo_caja where id = $1', [id]);
  const r = rows[0];
  if (!r) return;
  // Lo aplicado a facturas anuladas se considera dinero devuelto: no se contabiliza.
  const { rows: ap } = await client.query(
    `select coalesce(sum(a.valor), 0) as v from recibo_caja_aplicacion a join factura_venta f on f.id = a.factura_venta_id
     where a.recibo_caja_id = $1 and f.estado <> 'anulada'`, [id]
  );
  const aplicado = r2(ap[0].v);
  if (aplicado <= 0) return borrar(client, 'recibo_caja', id);
  const ret = { f: r2(r.retefuente), i: r2(r.reteiva), c: r2(r.reteica) };
  await guardarAsiento(client, {
    empresa_id: r.empresa_id, fecha: r.fecha, origen: 'recibo_caja', origen_id: id, descripcion: `Recibo de caja ${r.consecutivo} (${r.medio_pago})`,
    lineas: [
      { cuenta: cuentaDisponible(r.medio_pago), debito: r2(aplicado - ret.f - ret.i - ret.c) },
      { cuenta: '135515', tercero_id: r.tercero_id, debito: ret.f, descripcion: 'Retención en la fuente que nos practicaron' },
      { cuenta: '135517', tercero_id: r.tercero_id, debito: ret.i, descripcion: 'ReteIVA que nos practicaron' },
      { cuenta: '135518', tercero_id: r.tercero_id, debito: ret.c, descripcion: 'ReteICA que nos practicaron' },
      { cuenta: '1305', tercero_id: r.tercero_id, credito: aplicado },
    ],
  });
}

// ------------------------------------------------------- pagos a proveedores
export async function contabilizarPago(client, id) {
  const { rows } = await client.query('select * from pago_proveedor where id = $1', [id]);
  const p = rows[0];
  if (!p) return;
  const { rows: ap } = await client.query(
    `select c.clase, sum(a.valor) as v from pago_proveedor_aplicacion a join compra c on c.id = a.compra_id
     where a.pago_proveedor_id = $1 group by c.clase`, [id]
  );
  const lineas = ap.map((a) => ({ cuenta: a.clase === 'gasto' ? '2335' : '2205', tercero_id: p.tercero_id, debito: a.v }));
  const total = r2(ap.reduce((s, a) => s + Number(a.v), 0));
  lineas.push({ cuenta: cuentaDisponible(p.medio_pago), credito: total });
  await guardarAsiento(client, {
    empresa_id: p.empresa_id, fecha: p.fecha, origen: 'pago_proveedor', origen_id: id, descripcion: `Pago a proveedor ${p.consecutivo} (${p.medio_pago})`, lineas,
  });
}

// --------------------------------------- traslados entre empresas (mismo NIT)
export async function contabilizarTraslado(client, id) {
  const { rows } = await client.query(
    `select t.*, (t.creado_en at time zone 'America/Bogota')::date as dia, bo.empresa_id as emp_origen, bd.empresa_id as emp_destino
     from traslado t join bodega bo on bo.id = t.bodega_origen_id join bodega bd on bd.id = t.bodega_destino_id where t.id = $1`, [id]
  );
  const t = rows[0];
  if (!t) return;
  if (t.emp_origen === t.emp_destino) return borrar(client, 'traslado', id); // entre bodegas de la misma empresa: no hay asiento
  const valor = r2(Number(t.cantidad) * Number(t.costo_unitario));
  await guardarAsiento(client, {
    empresa_id: t.emp_origen, fecha: t.dia, origen: 'traslado', origen_id: id, periodo: 'origen', descripcion: 'Traslado enviado a otro centro de costo',
    lineas: [{ cuenta: '2895', debito: valor }, { cuenta: '1435', credito: valor }],
  });
  await guardarAsiento(client, {
    empresa_id: t.emp_destino, fecha: t.dia, origen: 'traslado', origen_id: id, periodo: 'destino', descripcion: 'Traslado recibido de otro centro de costo',
    lineas: [{ cuenta: '1435', debito: valor }, { cuenta: '2895', credito: valor }],
  });
}

// --------------------------------------------------------------- depreciación
// Línea recta mensual desde el mes siguiente a la compra, hasta el mes de `hasta`.
// Idempotente: solo crea los meses que falten. El último mes ajusta el redondeo.
export async function generarDepreciaciones(client, hasta = new Date()) {
  const finY = hasta.getFullYear(); const finM = hasta.getMonth() + 1;
  const { rows: activos } = await client.query(`select * from activo_fijo where activo and vida_util_meses > 0`);
  let creados = 0;
  for (const a of activos) {
    const { rows: hechos } = await client.query(`select periodo from asiento where origen = 'depreciacion' and origen_id = $1`, [a.id]);
    const ya = new Set(hechos.map((h) => h.periodo));
    const cuota = r2(Number(a.costo) / a.vida_util_meses);
    const f = new Date(a.fecha_compra);
    let y = f.getUTCFullYear(); let m = f.getUTCMonth() + 1;
    for (let n = 1; n <= a.vida_util_meses; n++) {
      m += 1; if (m > 12) { m = 1; y += 1; }
      if (y > finY || (y === finY && m > finM)) break;
      const periodo = `${y}-${String(m).padStart(2, '0')}`;
      if (ya.has(periodo)) continue;
      const valor = n === a.vida_util_meses ? r2(Number(a.costo) - cuota * (a.vida_util_meses - 1)) : cuota;
      const ultimoDia = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      await guardarAsiento(client, {
        empresa_id: a.empresa_id, fecha: ultimoDia, origen: 'depreciacion', origen_id: a.id, periodo,
        descripcion: `Depreciación ${periodo} · ${a.descripcion}`,
        lineas: [{ cuenta: '5160', debito: valor }, { cuenta: '1592', credito: valor }],
      });
      creados++;
    }
  }
  return creados;
}

// ------------------------------------------------------------- orquestación
const FUNCIONES = {
  factura_venta: contabilizarVenta,
  nota_credito: contabilizarNotaCredito,
  compra: contabilizarCompra,
  recibo_caja: contabilizarRecibo,
  pago_proveedor: contabilizarPago,
  traslado: contabilizarTraslado,
};

// Para llamar desde las rutas después de guardar un documento. Nunca rompe la
// operación: si falla, queda en el log y se corrige con la reconstrucción.
export async function contabilizar(origen, id) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await FUNCIONES[origen](client, id);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error(`[contabilidad] ${origen} ${id}:`, err.message);
  } finally {
    client.release();
  }
}

// Borra y vuelve a generar todos los asientos automáticos.
export async function reconstruirContabilidad() {
  const client = await pool.connect();
  const resumen = {};
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(4242)`);
    await client.query(`delete from asiento where origen <> 'manual'`);
    const fuentes = {
      factura_venta: 'select id from factura_venta order by fecha',
      nota_credito: 'select id from nota_credito order by fecha',
      compra: 'select id from compra order by fecha, creado_en',
      recibo_caja: 'select id from recibo_caja order by fecha, creado_en',
      pago_proveedor: 'select id from pago_proveedor order by fecha, creado_en',
      traslado: 'select id from traslado order by creado_en',
    };
    for (const [origen, sql] of Object.entries(fuentes)) {
      const { rows } = await client.query(sql);
      for (const r of rows) await FUNCIONES[origen](client, r.id);
      resumen[origen] = rows.length;
    }
    resumen.depreciaciones = await generarDepreciaciones(client);
    const { rows: c } = await client.query('select coalesce(sum(debito),0) as d, coalesce(sum(credito),0) as c from asiento_linea');
    resumen.debitos = Number(c[0].d); resumen.creditos = Number(c[0].c);
    await client.query('commit');
    return resumen;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Depreciación al día (se llama antes de generar informes y una vez al día).
export async function depreciacionAlDia() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const n = await generarDepreciaciones(client);
    await client.query('commit');
    return n;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
