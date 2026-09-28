// Notas crédito electrónicas a través de Arco ERP.
//
// Mismo flujo que src/dian/cliente.js pero para NotaCredito:
//   1. routes/notas-credito.js crea la nota local con estado_dian = 'pendiente'
//      (solo si la factura original fue emitida electrónicamente; si no, queda
//      'no_aplica' y nunca se envía).
//   2. enviarNotaCreditoADian(id) arma el JSON de Arco y hace NotaCredito/Insert
//      referenciando la factura original (FacturaId de Arco) → arco_nota_id.
//   3. sincronizarNotaCredito(id) hace NotaCredito/Get: cuando llega el CUFE la
//      nota queda 'aceptada'; si Arco reporta error, 'rechazada'.
//
// IMPORTANTE: a diferencia de Factura/Insert (ya probado contra el simulador
// de Arco, ver CHANGELOG), los nombres exactos de campos de NotaCredito/Insert
// y NotaCredito/Get NO se han podido confirmar contra la documentación de Arco
// (la documentación pública no expone el detalle de este endpoint). Los campos
// de abajo siguen el mismo patrón que Factura/Insert (mismo proveedor, misma
// convención de nombres). Antes de la primera nota crédito real hay que:
//   1. Confirmar estos nombres de campo contra Arco (soporte o Postman privado).
//   2. Probar contra el simulador, igual que se hizo con Factura/Insert.
// Nunca bloquea la operación local: cualquier fallo queda en dian_mensaje y se
// reintenta (mismo job de iniciarJobDian, ver más abajo).

import { pool } from '../db/pool.js';
import { ArcoClient, ArcoError } from './arco.js';

const MAX_INTENTOS = 12;

async function cargarNota(notaId) {
  const { rows } = await pool.query(
    `select n.*, f.arco_factura_id, f.consecutivo as factura_consecutivo,
            e.arco_config, e.nombre as empresa_nombre
     from nota_credito n
     join factura_venta f on f.id = n.factura_venta_id
     join empresa e on e.id = n.empresa_id
     where n.id = $1`,
    [notaId]
  );
  const n = rows[0];
  if (!n) throw new Error(`Nota crédito ${notaId} no existe`);
  const { rows: items } = await pool.query(
    `select i.cantidad, i.precio_unitario, p.arco_producto_id, p.impuesto_pct, p.nombre as producto
     from nota_credito_item i join producto p on p.id = i.producto_id
     where i.nota_credito_id = $1`,
    [notaId]
  );
  n.items = items;
  return n;
}

async function marcar(notaId, estado_dian, extra = {}) {
  const sets = ['estado_dian = $2', 'dian_ultimo_intento = now()'];
  const params = [notaId, estado_dian];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  await pool.query(`update nota_credito set ${sets.join(', ')} where id = $1`, params);
}

function armarDetalle(n, cfg) {
  const sinCodigo = n.items.filter((i) => !i.arco_producto_id).map((i) => i.producto);
  if (sinCodigo.length) {
    throw new Error(`Productos sin código Arco: ${sinCodigo.join(', ')}. Asígnalo en Inventario → producto.`);
  }
  return n.items.map((i) => {
    const precio = Number(i.precio_unitario);
    const pct = Number(i.impuesto_pct || 0);
    const base = cfg.precios_incluyen_impuesto !== false && pct > 0 ? precio / (1 + pct / 100) : precio;
    return {
      ProductoId: i.arco_producto_id,
      NotaCreditoDetalleCantidad: Number(i.cantidad),
      NotaCreditoDetalleVrUnitario: Math.round(base * 100) / 100,
      NotaCreditoDetalleDcto: 0,
    };
  });
}

export async function enviarNotaCreditoADian(notaId) {
  const n = await cargarNota(notaId);
  const cfg = n.arco_config;

  if (n.estado_dian === 'no_aplica') return { estado: 'no_aplica' };
  if (!cfg?.host) {
    await marcar(notaId, 'sin_configurar', { dian_mensaje: `${n.empresa_nombre} no tiene configurada la cuenta de Arco` });
    return { estado: 'sin_configurar' };
  }
  if (!n.arco_factura_id) {
    await marcar(notaId, 'error', { dian_mensaje: 'La factura original no tiene FacturaId de Arco (no fue emitida electrónicamente)' });
    return { estado: 'error' };
  }
  if (n.arco_nota_id) return sincronizarNotaCredito(notaId); // ya está en Arco; solo refrescar

  try {
    const arco = new ArcoClient(cfg);
    const detalle = armarDetalle(n, cfg);
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });

    const r = await arco.post('NotaCredito/Insert', {
      DocumentoId: Number(cfg.documento_id_nc || cfg.documento_id),
      FacturaId: String(n.arco_factura_id),
      NotaCreditoFecha: hoy,
      NotaCreditoConcepto: Number(n.razon), // mismos códigos DIAN 1-6
      NotaCreditoOrdenInterna: String(n.id),
      NotaCreditoNotas: `${n.notas || ''} — ${n.consecutivo}`.trim(),
      NotaCreditoSucursalId: String(cfg.sucursal_id),
      NotaCreditoBodegaId: n.reingresa_inventario ? String(cfg.bodega_id) : null,
      VendedorId: String(cfg.vendedor_id || '0'),
      Detalle: detalle,
    });

    if (!r?.NotaCreditoId) throw new Error(`Arco no devolvió NotaCreditoId: ${JSON.stringify(r).slice(0, 300)}`);
    await marcar(notaId, 'enviada', { arco_nota_id: String(r.NotaCreditoId), dian_mensaje: null, dian_intentos: 0 });
    return sincronizarNotaCredito(notaId);
  } catch (err) {
    const intentos = Number(n.dian_intentos || 0) + 1;
    const definitivo = err instanceof ArcoError && err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
    const estado = definitivo || intentos >= MAX_INTENTOS ? 'rechazada' : 'error';
    await marcar(notaId, estado, { dian_mensaje: err.message.slice(0, 2000), dian_intentos: intentos });
    return { estado, mensaje: err.message };
  }
}

export async function sincronizarNotaCredito(notaId) {
  const n = await cargarNota(notaId);
  if (!n.arco_nota_id || !n.arco_config?.host) return { estado: n.estado_dian };
  try {
    const arco = new ArcoClient(n.arco_config);
    const a = await arco.get(`NotaCredito/Get/${n.arco_nota_id}`);
    const cufe = (a.NotaCreditoCUFE || '').trim();
    const msg = (a.NotaCreditoMsgFE || '').trim();
    const extra = {
      cufe: cufe || null,
      pdf_url: a.NotaCreditoURLFE || null,
      dian_mensaje: msg || null,
    };
    let estado = 'enviada';
    if (cufe) estado = 'aceptada';
    else if (/rechaz|error|inv[aá]lid/i.test(msg)) estado = 'rechazada';
    await marcar(notaId, estado, extra);
    return { estado, cufe, mensaje: msg };
  } catch (err) {
    await marcar(notaId, 'enviada', { dian_mensaje: `Sin respuesta al consultar estado: ${err.message}`.slice(0, 2000) });
    return { estado: 'enviada', mensaje: err.message };
  }
}

// Job en segundo plano: reintenta pendientes y refresca las enviadas sin CUFE.
// Se registra junto al de facturas (ver server.js), con el mismo intervalo.
export function iniciarJobNotasCredito({ cadaMs = 2 * 60 * 1000 } = {}) {
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const { rows } = await pool.query(
        `select n.id, n.estado_dian from nota_credito n
         join empresa e on e.id = n.empresa_id
         where e.arco_config is not null
           and (
             (n.estado_dian in ('pendiente', 'error', 'sin_configurar') and n.dian_intentos < $1
               and (n.dian_ultimo_intento is null or n.dian_ultimo_intento < now() - interval '2 minutes'))
             or (n.estado_dian = 'enviada' and n.fecha > now() - interval '7 days'
               and (n.dian_ultimo_intento is null or n.dian_ultimo_intento < now() - interval '5 minutes'))
           )
         order by n.fecha asc limit 20`,
        [MAX_INTENTOS]
      );
      for (const r of rows) {
        try {
          if (r.estado_dian === 'enviada') await sincronizarNotaCredito(r.id);
          else await enviarNotaCreditoADian(r.id);
        } catch (err) {
          console.error(`Job NC ${r.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Job notas crédito:', err.message);
    } finally {
      corriendo = false;
    }
  };
  setTimeout(tick, 20_000);
  return setInterval(tick, cadaMs);
}
