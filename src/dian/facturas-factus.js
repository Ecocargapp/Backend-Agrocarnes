// Facturación electrónica a través de Factus (https://developers.factus.com.co).
//
// A diferencia de Arco, Factus valida y firma la factura en la misma llamada
// (POST /v2/bills/validate): normalmente ya vuelve con el CUFE. Flujo:
//   1. La venta se registra local (routes/ventas.js) con estado_dian = 'pendiente'.
//   2. enviarFacturaADian(id) arma el JSON de Factus y llama /v2/bills/validate,
//      usando el id local de la factura como reference_code (así el reintento es
//      idempotente: Factus devuelve el mismo documento si ya se había creado).
//      Si la respuesta trae cufe → 'aceptada'; si no, → 'enviada' (se reintenta
//      sincronizarEstado hasta que llegue).
//   3. sincronizarEstado(id) hace GET /v2/bills/:number cuando aún no hay CUFE.
// Nunca bloquea la venta: cualquier fallo queda en dian_mensaje y se reintenta
// (mismo job de src/dian/cliente.js).

import { pool } from '../db/pool.js';
import { FactusClient, FactusError, CONSUMIDOR_FINAL, codigoImpuesto, codigoMedioPago } from './factus.js';

const MAX_INTENTOS = 12;

// Mismos códigos DIAN que usa Arco (identification_document_code de Factus).
const TIPO_DOCUMENTO = { NIT: '31', CC: '13', CE: '22', TI: '12', PA: '41', PEP: '47' };

// Códigos de unidad UN/CEFACT más comunes; "94" (unidad) es un valor seguro por defecto.
const UNIDAD_MEDIDA = { kg: 'KGM', g: 'GRM', gr: 'GRM', l: 'LTR', lt: 'LTR', litro: 'LTR', lb: 'LBR', un: '94', unidad: '94' };

async function cargarFactura(facturaId) {
  const { rows } = await pool.query(
    `select f.*, e.factus_config, e.nombre as empresa_nombre,
            t.id as tercero_id, t.nombre as tercero_nombre, t.tipo_documento, t.numero_documento,
            t.email as tercero_email, t.telefono as tercero_telefono, t.direccion as tercero_direccion,
            t.ciudad_id as tercero_ciudad_id,
            (select r.medio_pago from recibo_caja_aplicacion a join recibo_caja r on r.id = a.recibo_caja_id
              where a.factura_venta_id = f.id order by r.creado_en limit 1) as medio_pago
     from factura_venta f
     join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id
     where f.id = $1`,
    [facturaId]
  );
  const f = rows[0];
  if (!f) throw new Error(`Factura ${facturaId} no existe`);
  const { rows: items } = await pool.query(
    `select i.cantidad, i.precio_unitario, p.id as producto_id, p.nombre as producto, p.unidad_medida,
            p.factus_unidad_medida_code, p.factus_estandar_code, p.impuesto_pct, p.tipo_impuesto
     from factura_venta_item i join producto p on p.id = i.producto_id
     where i.factura_venta_id = $1`,
    [facturaId]
  );
  f.items = items;
  return f;
}

async function marcar(facturaId, estado, extra = {}) {
  const sets = ['estado_dian = $2', 'dian_ultimo_intento = now()'];
  const params = [facturaId, estado];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  await pool.query(`update factura_venta set ${sets.join(', ')} where id = $1`, params);
}

function clienteFactus(f, cfg) {
  if (!f.tercero_id) {
    return cfg.cliente_default || CONSUMIDOR_FINAL;
  }
  return {
    identification_document_code: TIPO_DOCUMENTO[(f.tipo_documento || 'CC').toUpperCase()] || '13',
    identification: f.numero_documento || '222222222',
    names: f.tercero_nombre,
    address: f.tercero_direccion || 'No registra',
    email: f.tercero_email || undefined,
    phone: f.tercero_telefono || undefined,
    legal_organization_code: (f.tipo_documento || '').toUpperCase() === 'NIT' ? '1' : '2',
    tribute_code: 'ZZ',
    country_code: 'CO',
    municipality_code: f.tercero_ciudad_id || cfg.municipality_code_default || '05001',
  };
}

function armarItems(f) {
  return f.items.map((i) => {
    const precio = Number(i.precio_unitario);
    const pct = Number(i.impuesto_pct || 0);
    const base = pct > 0 ? precio / (1 + pct / 100) : precio;
    const unidad = i.factus_unidad_medida_code || UNIDAD_MEDIDA[(i.unidad_medida || '').toLowerCase()] || '94';
    return {
      code_reference: i.producto_id,
      name: i.producto,
      quantity: String(Number(i.cantidad).toFixed(2)),
      discount_rate: '0.00',
      price: (Math.round(base * 100) / 100).toFixed(2),
      unit_measure_code: unidad,
      standard_code: i.factus_estandar_code || '999',
      taxes: pct > 0 ? [{ code: codigoImpuesto(i.tipo_impuesto), rate: pct.toFixed(2) }] : [],
    };
  });
}

function extraerNumeroYCufe(r) {
  // La respuesta puede traer los campos bajo data.bill.* (notas crédito) o
  // directamente en data.* (facturas); se soportan ambas formas.
  const data = r?.data || {};
  const doc = data.bill || data;
  return { number: doc.number || data.number, cufe: doc.cufe || data.cufe, links: doc.links || data.links };
}

export async function enviarFacturaADian(facturaId) {
  const f = await cargarFactura(facturaId);
  const cfg = f.factus_config;

  if (!cfg?.client_id) {
    await marcar(facturaId, 'sin_configurar', { dian_mensaje: `${f.empresa_nombre} no tiene configurada la cuenta de Factus` });
    return { estado: 'sin_configurar' };
  }

  try {
    const factus = new FactusClient(cfg);
    const totalFactura = f.items.reduce((s, i) => s + Number(i.cantidad) * Number(i.precio_unitario), 0);
    const body = {
      reference_code: `AGC-${f.id}`,
      document: '01',
      operation_type: '10',
      observation: `Agrocarnes ${f.consecutivo || ''}`.trim(),
      numbering_range_id: cfg.numbering_range_id_factura || undefined,
      payment_details: [
        {
          payment_form: f.forma_pago === 'credito' ? '2' : '1',
          payment_method_code: f.forma_pago === 'credito' ? '1' : codigoMedioPago(f.medio_pago, cfg.payment_method_code_default),
          reference_code: String(f.id),
          amount: totalFactura.toFixed(2),
          due_date: f.forma_pago === 'credito' && f.fecha_vencimiento ? String(f.fecha_vencimiento).slice(0, 10) : undefined,
        },
      ],
      customer: clienteFactus(f, cfg),
      items: armarItems(f),
    };

    const r = await factus.post('v2/bills/validate', body);
    const { number, cufe } = extraerNumeroYCufe(r);
    if (!number) throw new Error(`Factus no devolvió el número del documento: ${JSON.stringify(r).slice(0, 300)}`);

    const extra = { consecutivo: number, cufe: cufe || null, dian_mensaje: (r.data?.errors || []).join(' · ') || null, dian_intentos: 0 };
    await marcar(facturaId, cufe ? 'aceptada' : 'enviada', extra);
    return { estado: cufe ? 'aceptada' : 'enviada', cufe, consecutivo: number };
  } catch (err) {
    const intentos = Number(f.dian_intentos || 0) + 1;
    const definitivo = err instanceof FactusError && err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
    const estado = definitivo || intentos >= MAX_INTENTOS ? 'rechazada' : 'error';
    await marcar(facturaId, estado, { dian_mensaje: err.message.slice(0, 2000), dian_intentos: intentos });
    return { estado, mensaje: err.message };
  }
}

export async function sincronizarEstado(facturaId) {
  const f = await cargarFactura(facturaId);
  if (!f.consecutivo || !f.factus_config?.client_id || f.cufe) return { estado: f.estado_dian };
  try {
    const factus = new FactusClient(f.factus_config);
    const r = await factus.get(`v2/bills/${f.consecutivo}`);
    const { cufe } = extraerNumeroYCufe(r);
    const estado = cufe ? 'aceptada' : 'enviada';
    await marcar(facturaId, estado, { cufe: cufe || null, dian_mensaje: null });
    return { estado, cufe };
  } catch (err) {
    await marcar(facturaId, 'enviada', { dian_mensaje: `Sin respuesta al consultar estado: ${err.message}`.slice(0, 2000) });
    return { estado: 'enviada', mensaje: err.message };
  }
}

// Prueba las credenciales y devuelve los rangos de numeración disponibles
// (para elegir numbering_range_id_factura / numbering_range_id_nota_credito).
export async function probarConexion(cfg) {
  const factus = new FactusClient(cfg);
  await factus.login();
  const rangos = await factus.get('v2/numbering-ranges');
  const lista = rangos?.data?.data || rangos?.data || [];
  return {
    ok: true,
    rangos_numeracion: lista.map((r) => ({ id: r.id, documento: r.document, prefijo: r.prefix, activo: r.is_active })),
  };
}
