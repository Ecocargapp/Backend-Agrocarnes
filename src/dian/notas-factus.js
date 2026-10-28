// Notas crédito electrónicas a través de Factus.
//
// Igual que src/dian/facturas-factus.js: POST /v2/credit-notes/validate valida
// y firma en la misma llamada (normalmente ya vuelve con el CUFE). Se usa el id
// local de la nota como reference_code, así el reintento es idempotente.
// Probado contra el sandbox de Factus (ver CHANGELOG): login, numbering-ranges,
// creación de factura y de nota crédito referenciándola, todo con datos de
// prueba — antes de la primera nota real hay que confirmar en el sandbox que
// el payment_method_code usado para una nota que anula una venta a crédito
// (por ahora "1", sin verificar contra la tabla completa de Factus) es correcto.

import { pool } from '../db/pool.js';
import { FactusClient, FactusError, itemsFactus, errorDeCantidad, CONSUMIDOR_FINAL, codigoImpuesto, codigoMedioPago, textoErrores, adquirienteFactus, descartarNoValidado, enviarConReintento } from './factus.js';

const MAX_INTENTOS = 12;
const TIPO_DOCUMENTO = { CC: '13', NIT: '31', RC: '11', TI: '12', TE: '21', CE: '22', PA: '41', DE: '42', PEP: '47', EX: '43' };
const UNIDAD_MEDIDA = { kg: 'KGM', g: 'GRM', gr: 'GRM', l: 'LTR', lt: 'LTR', litro: 'LTR', lb: 'LBR', un: '94', unidad: '94' };

async function cargarNota(notaId) {
  const { rows } = await pool.query(
    `select n.*, f.consecutivo as factura_consecutivo, f.forma_pago, f.fecha_vencimiento,
            e.factus_config, e.nombre as empresa_nombre,
            t.id as tercero_id, t.nombre as tercero_nombre, t.razon_social as tercero_razon_social, t.tipo_documento, t.numero_documento,
            t.email as tercero_email, t.telefono as tercero_telefono, t.direccion as tercero_direccion,
            t.ciudad_id as tercero_ciudad_id, t.tipo_persona as tercero_tipo_persona, t.nombre_comercial as tercero_nombre_comercial, t.regimen_iva as tercero_regimen_iva
     from nota_credito n
     join factura_venta f on f.id = n.factura_venta_id
     join empresa e on e.id = n.empresa_id
     left join tercero t on t.id = f.cliente_id
     where n.id = $1`,
    [notaId]
  );
  const n = rows[0];
  if (!n) throw new Error(`Nota crédito ${notaId} no existe`);
  const { rows: items } = await pool.query(
    `select i.cantidad, i.precio_unitario, p.id as producto_id, p.nombre as producto, p.unidad_medida,
            p.factus_unidad_medida_code, p.factus_estandar_code, p.impuesto_pct, p.tipo_impuesto, p.codigo
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

function clienteFactus(n, cfg) {
  return adquirienteFactus(n, cfg, TIPO_DOCUMENTO);
}

function armarItems(n, decimales = 3) {
  const { lista, total } = itemsFactus(n.items, { decimales });
  const items = lista.map(({ i, quantity, price, pct }) => ({
    code_reference: i.codigo || i.producto_id,
    name: i.producto,
    quantity,
    discount_rate: '0.00',
    price,
    unit_measure_code: i.factus_unidad_medida_code || UNIDAD_MEDIDA[(i.unidad_medida || '').toLowerCase()] || '94',
    standard_code: i.factus_estandar_code || '999',
    // Factus exige al menos un impuesto por ítem: los productos sin impuesto
    // (carne fresca, exenta) van con IVA 0 %.
    taxes: [pct > 0 ? { code: codigoImpuesto(i.tipo_impuesto), rate: pct.toFixed(2) } : { code: '01', rate: '0.00' }],
  }));
  return { items, total };
}

function extraerNumeroYCufe(r) {
  const data = r?.data || {};
  return { number: data.number, cufe: data.cufe };
}

export async function enviarNotaCreditoADian(notaId) {
  const n = await cargarNota(notaId);
  const cfg = n.factus_config;

  if (n.estado_dian === 'no_aplica') return { estado: 'no_aplica' };
  if (!cfg?.client_id) {
    await marcar(notaId, 'sin_configurar', { dian_mensaje: `${n.empresa_nombre} no tiene configurada la cuenta de Factus` });
    return { estado: 'sin_configurar' };
  }
  if (!n.factura_consecutivo) {
    await marcar(notaId, 'error', { dian_mensaje: 'La factura original no tiene número de Factus (no fue emitida electrónicamente)' });
    return { estado: 'error' };
  }

  try {
    const factus = new FactusClient(cfg);
    const armado = armarItems(n);
    const body = {
      reference_code: `AGC-NC-${n.id}`,
      correction_concept_code: String(n.razon),
      numbering_range_id: cfg.numbering_range_id_nota_credito || undefined,
      bill_number: n.factura_consecutivo,
      observation: `${n.notas || ''} — ${n.consecutivo || ''}`.trim(),
      payment_details: [
        {
          payment_form: n.forma_pago === 'credito' ? '2' : '1',
          payment_method_code: n.forma_pago === 'credito' ? '1' : (cfg.payment_method_code_default || '10'),
          reference_code: String(n.id),
          amount: armado.total.toFixed(2),
        },
      ],
      customer: clienteFactus(n, cfg),
      items: armado.items,
    };

    // Reintento de un documento que ya falló: se borra la versión que Factus
    // tiene guardada para que tome los datos corregidos (cliente, ítems…).
    const rutaBorrar = `v2/credit-notes/reference/AGC-NC-${n.id}`;
    if (Number(n.dian_intentos || 0) > 0 || ['rechazada', 'error'].includes(n.estado_dian)) {
      await descartarNoValidado(factus, rutaBorrar);
    }

    let r;
    try {
      r = await enviarConReintento(factus, 'v2/credit-notes/validate', body, rutaBorrar);
    } catch (e) {
      // Si Factus no acepta cantidades con 3 decimales, se reenvía con 2 y el
      // precio ajustado para que el valor de cada línea sea el mismo.
      if (!errorDeCantidad(e)) throw e;
      const a2 = armarItems(n, 2);
      body.items = a2.items;
      body.payment_details[0].amount = a2.total.toFixed(2);
      try {
        r = await enviarConReintento(factus, 'v2/credit-notes/validate', body, rutaBorrar);
      } catch (e2) {
        // Se deja también el error del primer intento (3 decimales) para el diagnóstico.
        e2.message = `${e2.message} · Primer intento (3 decimales): ${e.message}`.slice(0, 2000);
        throw e2;
      }
    }
    const { number, cufe } = extraerNumeroYCufe(r);
    if (!number) throw new Error(`Factus no devolvió el número de la nota: ${JSON.stringify(r).slice(0, 300)}`);

    const extra = { consecutivo: number, cufe: cufe || null, dian_mensaje: textoErrores(r.data?.errors ?? r.data?.bill?.errors), dian_intentos: 0 };
    await marcar(notaId, cufe ? 'aceptada' : 'enviada', extra);
    return { estado: cufe ? 'aceptada' : 'enviada', cufe, consecutivo: number };
  } catch (err) {
    const intentos = Number(n.dian_intentos || 0) + 1;
    const definitivo = err instanceof FactusError && err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
    const estado = definitivo || intentos >= MAX_INTENTOS ? 'rechazada' : 'error';
    await marcar(notaId, estado, { dian_mensaje: err.message.slice(0, 2000), dian_intentos: intentos });
    return { estado, mensaje: err.message };
  }
}

export async function sincronizarNotaCredito(notaId) {
  const n = await cargarNota(notaId);
  if (!n.consecutivo || !n.factus_config?.client_id || n.cufe) return { estado: n.estado_dian };
  try {
    const factus = new FactusClient(n.factus_config);
    const r = await factus.get(`v2/credit-notes/${n.consecutivo}`);
    const { cufe } = extraerNumeroYCufe(r);
    const estado = cufe ? 'aceptada' : 'enviada';
    await marcar(notaId, estado, { cufe: cufe || null, dian_mensaje: null });
    return { estado, cufe };
  } catch (err) {
    await marcar(notaId, 'enviada', { dian_mensaje: `Sin respuesta al consultar estado: ${err.message}`.slice(0, 2000) });
    return { estado: 'enviada', mensaje: err.message };
  }
}
