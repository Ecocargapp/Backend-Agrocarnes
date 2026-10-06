// Nómina electrónica con Factus (https://developers.factus.com.co/nomina/).
//
//   POST v2/payrolls                       → crea y valida la nómina ante la DIAN (devuelve number, cune)
//   POST v2/adjustment-payrolls            → nota de ajuste de ELIMINACIÓN de una nómina ya validada
//   GET  v2/payrolls/:number/download-pdf  → representación gráfica
//   GET  v2/numbering-ranges/payrolls      → rangos de numeración de nómina y notas de ajuste
//
// La cuenta de Factus de nómina se lee de empresa.nomina_config, que puede
// apuntar a la misma cuenta de facturación (misma_cuenta_factura) o a la de
// otra empresa de la misma razón social (usar_empresa_id).
import { pool } from '../db/pool.js';
import { FactusClient, FactusError, textoErrores } from './factus.js';

// Medio de pago local → código DIAN.
const MEDIO = { efectivo: '10', cheque: '20', consignacion: '42', transferencia: '47', billetera: '98' };
const CON_BANCO = ['42', '47', '98'];
const dinero = (n) => Number(n || 0).toFixed(2);
// Fecha 'AAAA-MM-DD' (pg entrega las columnas date como Date a medianoche local).
const ymd = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10));
// 'AAAA-MM-DDTHH:MM[:SS]' → 'AAAA-MM-DD HH:MM:SS' (formato del ejemplo de la documentación de Factus).
function fechaHora(s) {
  if (!s) return undefined;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4] || '00'}` : undefined;
}

// Configuración efectiva de Factus para la nómina de una empresa.
export async function configNomina(empresaId, db = pool) {
  const { rows } = await db.query('select id, nombre, factus_config, nomina_config from empresa where id = $1', [empresaId]);
  let e = rows[0];
  if (!e) throw new Error('Empresa no encontrada');
  let nc = e.nomina_config || {};
  if (nc.usar_empresa_id && nc.usar_empresa_id !== e.id) {
    const { rows: o } = await db.query('select id, nombre, factus_config, nomina_config from empresa where id = $1', [nc.usar_empresa_id]);
    if (o[0]) { e = o[0]; nc = e.nomina_config || {}; }
  }
  const credenciales = nc.misma_cuenta_factura ? (e.factus_config || {}) : nc;
  if (!credenciales?.client_id) return null;
  return {
    base_url: credenciales.base_url, client_id: credenciales.client_id, client_secret: credenciales.client_secret,
    email: credenciales.email, password: credenciales.password,
    numbering_range_id_nomina: nc.numbering_range_id_nomina || null,
    numbering_range_id_ajuste: nc.numbering_range_id_ajuste || null,
    empresa_cuenta: e.nombre,
  };
}

// Arma el cuerpo de POST v2/payrolls a partir de una nómina guardada.
export function armarNomina(n, cfg = {}) {
  const e = n.empleado_snapshot;
  const L = n.liquidacion;
  const medio = MEDIO[n.medio_pago] || '10';
  const de = (clave) => L.devengados.filter((d) => d.clave === clave);
  const uno = (clave) => L.deducciones.find((d) => d.clave === clave);
  const fecha = (s) => (s ? String(s).slice(0, 10) : undefined);

  const accruals = {};
  const suel = de('suel')[0];
  accruals.suel = { accrual_type_code: '1', amount: dinero(suel?.valor) };
  if (de('tra').length) accruals.tra = de('tra').map((d) => ({ accrual_type_code: d.codigo, amount: dinero(d.valor) }));
  if (de('hora').length) {
    accruals.hora = de('hora').map((d) => ({
      accrual_type_code: d.codigo, quantity: String(d.cantidad), percentage: dinero(d.porcentaje), amount: dinero(d.valor),
      start_date: fechaHora(d.inicio), end_date: fechaHora(d.fin),
    }));
  }
  if (de('vaca').length) accruals.vaca = de('vaca').map((d) => ({ accrual_type_code: d.codigo, quantity: Number(d.cantidad), amount: dinero(d.valor), start_date: fecha(d.desde), end_date: fecha(d.hasta) }));
  if (de('lice').length) {
    accruals.lice = de('lice').map((d) => ({ accrual_type_code: d.codigo, quantity: Number(d.cantidad), amount: d.codigo === '3' ? undefined : dinero(d.valor), start_date: fecha(d.desde), end_date: fecha(d.hasta) }));
  }
  if (de('inca').length) accruals.inca = de('inca').map((d) => ({ accrual_type_code: d.codigo, quantity: Number(d.cantidad), amount: dinero(d.valor), start_date: fecha(d.desde), end_date: fecha(d.hasta) }));
  const prima = de('prim')[0];
  if (prima) accruals.prim = { accrual_type_code: '1', quantity: Number(prima.cantidad), amount: dinero(prima.valor) };
  if (de('cesa').length) accruals.cesa = de('cesa').map((d) => ({ accrual_type_code: d.codigo, amount: dinero(d.valor), percentage: d.codigo === '2' ? dinero(d.porcentaje) : undefined }));
  if (de('comi').length) accruals.comi = de('comi').map((d) => ({ accrual_type_code: '1', amount: dinero(d.valor) }));
  if (de('boni').length) accruals.boni = de('boni').map((d) => ({ accrual_type_code: d.codigo, amount: dinero(d.valor) }));
  if (de('auxi').length) accruals.auxi = de('auxi').map((d) => ({ accrual_type_code: d.codigo, amount: dinero(d.valor) }));
  if (de('otro').length) accruals.otro = de('otro').map((d) => ({ accrual_type_code: d.codigo, description: d.descripcion || d.nombre, amount: dinero(d.valor) }));

  const deductions = {};
  const salu = uno('salu');
  const pens = uno('pens');
  // Salud y pensión van siempre (en 0 si el trabajador no aporta, p. ej. aprendiz).
  deductions.salu = { deduction_type_code: '1', percentage: dinero(salu?.porcentaje ?? 0), amount: dinero(salu?.valor ?? 0) };
  deductions.pens = { deduction_type_code: '1', percentage: dinero(pens?.porcentaje ?? 0), amount: dinero(pens?.valor ?? 0) };
  const fsp = uno('dedu');
  if (fsp) deductions.dedu = { deduction_type_code: '1', percentage: dinero(fsp.porcentaje), amount: dinero(fsp.valor) };
  const lista = (clave, extra = () => ({})) => L.deducciones.filter((d) => d.clave === clave).map((d) => ({ deduction_type_code: '1', amount: dinero(d.valor), ...extra(d) }));
  if (uno('sind')) deductions.sind = lista('sind', (d) => ({ percentage: dinero(d.porcentaje) }));
  if (uno('libr')) deductions.libr = lista('libr', (d) => ({ description: d.descripcion || 'Libranza' }));
  if (uno('anti')) deductions.anti = lista('anti');
  if (uno('otra')) deductions.otra = lista('otra');
  for (const clave of ['pevo', 'rete', 'afco']) {
    const d = uno(clave);
    if (d) deductions[clave] = { deduction_type_code: '1', amount: dinero(d.valor) };
  }

  const banco = CON_BANCO.includes(medio);
  return limpiar({
    reference_code: n.referencia_envio || `NOM-${n.id}`,
    observation: n.observacion || undefined,
    numbering_range_id: cfg.numbering_range_id_nomina || undefined,
    settlement_period: {
      month: String(n.mes), year: String(n.anio), payroll_period_code: String(n.periodo),
      pay_period_half: String(n.periodo) === '4' ? (n.quincena === '2nd' ? 2 : 1) : undefined, // Factus exige entero (1 o 2), no '1st'/'2nd'
    },
    payment: {
      payment_method_code: medio,
      bank_name: banco ? e.banco : undefined,
      account_type: banco ? String(e.tipo_cuenta || '2') : undefined,
      account_number: banco ? e.numero_cuenta : undefined,
      payment_date: ymd(n.fecha_pago),
    },
    worker: {
      identification_document_code: String(e.tipo_documento || '13'),
      identification_number: String(e.numero_documento),
      first_name: e.primer_nombre,
      other_names: e.otros_nombres || undefined,
      first_surname: e.primer_apellido,
      second_surname: e.segundo_apellido || '',
      address: e.direccion || 'No registra',
      country_code: 'CO',
      municipality_code: e.municipio_codigo || '05887',
      has_integral_salary: Boolean(e.salario_integral),
      has_high_risk: Boolean(e.alto_riesgo),
      worker_type_code: String(e.tipo_trabajador || '01'),
      worker_subtype: String(e.subtipo_trabajador || '00'),
      contract_type: String(e.tipo_contrato || '2'),
      employee_code: e.codigo || undefined,
      salary: dinero(e.salario),
      entry_date: String(e.fecha_ingreso).slice(0, 10),
      retirement_date: e.fecha_retiro && String(e.fecha_retiro).slice(0, 7) === `${n.anio}-${String(n.mes).padStart(2, '0')}` ? String(e.fecha_retiro).slice(0, 10) : undefined,
      days_worked: dinero(L.dias_trabajados),
    },
    accruals,
    deductions,
  });
}

// Quita claves undefined (Factus rechaza objetos con campos vacíos).
function limpiar(v) {
  if (Array.isArray(v)) return v.map(limpiar);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, limpiar(x)]));
  }
  return v;
}

async function cargar(id) {
  const { rows } = await pool.query('select n.*, e.nombre as empresa_nombre from nomina n join empresa e on e.id = n.empresa_id where n.id = $1', [id]);
  if (!rows[0]) throw new Error('Nómina no encontrada');
  return rows[0];
}

async function marcar(id, estado, extra = {}) {
  const campos = { estado_dian: estado, dian_fecha: new Date(), ...extra };
  const keys = Object.keys(campos);
  await pool.query(`update nomina set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => campos[k])]);
}

// Envía (o reenvía) una nómina a la DIAN a través de Factus.
export async function enviarNomina(id) {
  const n = await cargar(id);
  if (n.estado === 'anulado') throw new Error('La nómina está anulada');
  if (n.cune) return { estado: 'aceptada', numero: n.numero, cune: n.cune };
  const cfg = await configNomina(n.empresa_id);
  if (!cfg) {
    await marcar(id, 'sin_configurar', { dian_mensaje: `${n.empresa_nombre} no tiene configurada la cuenta de Factus para nómina` });
    return { estado: 'sin_configurar' };
  }
  // Un reenvío después de un rechazo necesita un reference_code nuevo.
  const intento = Number(n.dian_intentos || 0);
  const referencia = intento > 0 && ['rechazada', 'error'].includes(n.estado_dian) ? `NOM-${n.id.slice(0, 8)}-${intento + 1}` : (n.referencia_envio || `NOM-${n.id.slice(0, 8)}-1`);
  await pool.query('update nomina set referencia_envio = $2 where id = $1', [id, referencia]);
  try {
    const factus = new FactusClient(cfg);
    const body = armarNomina({ ...n, referencia_envio: referencia }, cfg);
    const r = await factus.post('v2/payrolls', body);
    const d = r?.data || {};
    if (!d.number) throw new Error(`Factus no devolvió el número de la nómina: ${JSON.stringify(r).slice(0, 300)}`);
    const aceptada = Boolean(d.cune) && d.is_validated !== false;
    await marcar(id, aceptada ? 'aceptada' : 'rechazada', {
      numero: d.number, cune: d.cune || null, qr: d.qr || null, dian_mensaje: textoErrores(d.errors), dian_intentos: intento + 1,
    });
    return { estado: aceptada ? 'aceptada' : 'rechazada', numero: d.number, cune: d.cune, mensaje: textoErrores(d.errors) };
  } catch (err) {
    const rechazo = err instanceof FactusError && err.status >= 400 && err.status < 500 && ![401, 429].includes(err.status);
    // Si Factus falló (5xx) o la dejó pendiente, se borra allá (solo es posible si
    // no está validada) para que el reintento o las siguientes no queden bloqueados (409).
    if (err instanceof FactusError && (err.status >= 500 || err.status === 409)) {
      await new FactusClient(cfg).delete(`v2/payrolls/reference/${encodeURIComponent(referencia)}`).catch(() => {});
    }
    const mensaje = err instanceof FactusError ? (textoErrores(err.body?.data?.errors || err.body?.errors) || err.message) : err.message;
    await marcar(id, rechazo ? 'rechazada' : 'error', { dian_mensaje: String(mensaje).slice(0, 2000), dian_intentos: intento + 1 });
    return { estado: rechazo ? 'rechazada' : 'error', mensaje };
  }
}

// Nota de ajuste de eliminación (anula ante la DIAN una nómina ya validada).
export async function eliminarNominaDian(n) {
  const cfg = await configNomina(n.empresa_id);
  if (!cfg) throw new Error('La empresa no tiene configurada la cuenta de Factus para nómina');
  const factus = new FactusClient(cfg);
  try {
    const r = await factus.post('v2/adjustment-payrolls', {
      payroll_number: n.numero,
      reference_code: `AJU-${n.id.slice(0, 8)}-${Date.now().toString(36)}`,
      numbering_range_id: cfg.numbering_range_id_ajuste || undefined,
    });
    const d = r?.data || {};
    if (!d.cune && d.is_validated === false) throw new Error(`La DIAN no validó la nota de ajuste: ${textoErrores(d.errors) || 'sin detalle'}`);
    return { numero: d.number, cune: d.cune };
  } catch (err) {
    if (err instanceof FactusError) throw new Error(`Factus no aceptó la nota de ajuste: ${textoErrores(err.body?.data?.errors || err.body?.errors) || err.message}`);
    throw err;
  }
}

export async function pdfNomina(id) {
  const n = await cargar(id);
  if (!n.cune || !n.numero) throw new Error('La nómina todavía no ha sido aceptada por la DIAN; no hay PDF');
  const cfg = await configNomina(n.empresa_id);
  if (!cfg) throw new Error('La empresa no tiene configurada la cuenta de Factus para nómina');
  const r = await new FactusClient(cfg).get(`v2/payrolls/${encodeURIComponent(n.numero)}/download-pdf`);
  const d = r?.data || {};
  const b64 = d.pdf_base_64_encoded || d.pdf_base64 || d.file;
  if (!b64) throw new Error('Factus no devolvió el PDF');
  return { nombre: `${d.file_name || n.numero}.pdf`.replace(/\.pdf\.pdf$/, '.pdf'), buffer: Buffer.from(b64, 'base64') };
}

// Prueba credenciales y lista los rangos de nómina / notas de ajuste.
export async function probarConexionNomina(cfg) {
  const factus = new FactusClient(cfg);
  await factus.login();
  const r = await factus.get('v2/numbering-ranges/payrolls');
  const lista = r?.data?.data || r?.data || [];
  return {
    ok: true,
    rangos: (Array.isArray(lista) ? lista : []).map((x) => ({
      id: x.id, documento: x.document_name || x.document, codigo_documento: x.document, prefijo: x.prefix, actual: x.current,
      resolucion: x.resolution_number, activo: x.is_active === true || Number(x.is_active) === 1,
    })),
  };
}

export async function crearRangoNomina(cfg, { documento, prefijo, actual = 1 }) {
  const r = await new FactusClient(cfg).post('v2/numbering-ranges/payrolls', { document: String(documento), prefix: String(prefijo).trim(), current: String(actual) });
  const d = r?.data || {};
  return { id: d.id, documento: d.document_name || d.document, prefijo: d.prefix, actual: d.current };
}
