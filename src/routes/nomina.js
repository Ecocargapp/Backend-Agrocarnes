// Nómina electrónica: trabajadores, liquidación por periodo, envío a la DIAN
// (Factus), PDF, anulación con nota de ajuste y configuración de la cuenta.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { liquidar } from '../nomina/liquidar.js';
import * as P from '../nomina/parametros.js';
import { contabilizar } from '../contabilidad/contabilizar.js';
import { resolverCuentaPago } from '../contabilidad/cuentas-pago.js';
import { configPublica } from '../dian/factus.js';
import {
  enviarNomina, eliminarNominaDian, pdfNomina, probarConexionNomina, crearRangoNomina, configNomina,
} from '../dian/nomina-factus.js';

export const router = Router();

const CAMPOS_EMPLEADO = [
  'empresa_id', 'codigo', 'tipo_documento', 'numero_documento', 'primer_nombre', 'otros_nombres', 'primer_apellido',
  'segundo_apellido', 'direccion', 'municipio_codigo', 'email', 'telefono', 'cargo', 'tipo_trabajador', 'subtipo_trabajador',
  'tipo_contrato', 'salario', 'salario_integral', 'alto_riesgo', 'clase_riesgo_arl', 'periodo_pago', 'fecha_ingreso',
  'fecha_retiro', 'medio_pago', 'banco', 'tipo_cuenta', 'numero_cuenta', 'activo',
];
const vacioANull = (v) => (v === '' || v === undefined ? null : v);
const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1;

function validarEmpleado(e) {
  for (const c of ['empresa_id', 'numero_documento', 'primer_nombre', 'primer_apellido', 'salario', 'fecha_ingreso']) {
    if (!e[c]) throw new Error(`Falta ${c.replace(/_/g, ' ')}`);
  }
  if (!(Number(e.salario) > 0)) throw new Error('El salario debe ser mayor que cero');
  if (e.municipio_codigo && !/^\d{5}$/.test(e.municipio_codigo)) throw new Error('El municipio es el código DANE de 5 dígitos (05887 Yarumal)');
  if (['transferencia', 'consignacion'].includes(e.medio_pago) && (!e.banco || !e.numero_cuenta)) {
    throw new Error('Para pagar por transferencia o consignación se necesitan banco y número de cuenta');
  }
  if (bool(e.salario_integral) && Number(e.salario) < 13 * P.smmlv(new Date().getFullYear())) {
    throw new Error('El salario integral no puede ser menor a 13 salarios mínimos');
  }
}

// ---------------------------------------------------------------- parámetros
router.get('/parametros', (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  const fecha = req.query.fecha || `${anio}-${String(new Date().getMonth() + 1).padStart(2, '0')}-15`;
  res.json({
    anio, smmlv: P.smmlv(anio), auxilio_transporte: P.auxTransporte(anio), uvt: P.uvt(anio), horas_mes: P.horasMes(fecha),
    tipos_hora: Object.entries(P.TIPOS_HORA).map(([codigo, t]) => ({ codigo, nombre: t.nombre, porcentaje: t.pct(fecha), extra: t.extra })),
  });
});

// ---------------------------------------------------------------- empleados
router.get('/empleados', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.empresa_id) { params.push(req.query.empresa_id); where.push(`m.empresa_id = $${params.length}`); }
  if (req.query.activos === 'true') where.push('m.activo');
  const { rows } = await pool.query(
    `select m.*, e.nombre as empresa,
            trim(concat_ws(' ', m.primer_nombre, m.otros_nombres, m.primer_apellido, m.segundo_apellido)) as nombre
     from empleado m join empresa e on e.id = m.empresa_id
     ${where.length ? `where ${where.join(' and ')}` : ''} order by m.activo desc, m.primer_apellido, m.primer_nombre`, params
  );
  res.json(rows);
});

router.post('/empleados', requireRole('admin'), async (req, res) => {
  const e = Object.fromEntries(CAMPOS_EMPLEADO.map((c) => [c, vacioANull(req.body?.[c])]));
  try {
    validarEmpleado(e);
    e.salario_integral = bool(e.salario_integral); e.alto_riesgo = bool(e.alto_riesgo); e.activo = e.activo === null ? true : bool(e.activo);
    const cols = CAMPOS_EMPLEADO.filter((c) => e[c] !== null);
    const { rows } = await pool.query(
      `insert into empleado (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, cols.map((c) => e[c])
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.code === '23505' ? 'Ya existe un trabajador con ese documento en esta empresa' : err.message });
  }
});

router.patch('/empleados/:id', requireRole('admin'), async (req, res) => {
  const { rows: act } = await pool.query('select * from empleado where id = $1', [req.params.id]);
  if (!act[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const cambios = Object.fromEntries(CAMPOS_EMPLEADO.filter((c) => c in (req.body || {})).map((c) => [c, vacioANull(req.body[c])]));
  for (const c of ['salario_integral', 'alto_riesgo', 'activo']) if (c in cambios) cambios[c] = bool(cambios[c]);
  try {
    validarEmpleado({ ...act[0], ...cambios, fecha_ingreso: (cambios.fecha_ingreso ?? act[0].fecha_ingreso) });
    const cols = Object.keys(cambios);
    if (!cols.length) return res.json(act[0]);
    const { rows } = await pool.query(
      `update empleado set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning *`, [req.params.id, ...cols.map((c) => cambios[c])]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.code === '23505' ? 'Ya existe un trabajador con ese documento en esta empresa' : err.message });
  }
});

// ---------------------------------------------------------------- liquidación
async function cargarEmpleado(id, db = pool) {
  const { rows } = await db.query('select * from empleado where id = $1', [id]);
  if (!rows[0]) throw new Error('Trabajador no encontrado');
  return rows[0];
}

const ymd = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : (v ? String(v).slice(0, 10) : null));

function entradaLiquidacion(empleado, b) {
  const periodo = String(b.periodo || empleado.periodo_pago || '5');
  return {
    empleado: { ...empleado, salario: Number(empleado.salario), fecha_ingreso: ymd(empleado.fecha_ingreso), fecha_retiro: ymd(empleado.fecha_retiro), creado_en: undefined },
    anio: Number(b.anio), mes: Number(b.mes), periodo, quincena: periodo === '4' ? (b.quincena || '1st') : null, novedades: b.novedades || {},
  };
}

router.post('/previsualizar', async (req, res) => {
  try {
    const empleado = await cargarEmpleado(req.body?.empleado_id);
    res.json(liquidar(entradaLiquidacion(empleado, req.body || {})));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Crea la nómina de un trabajador y (por defecto) la envía a la DIAN.
// body: { empleado_id, anio, mes, periodo?, quincena?, fecha_pago, medio_pago?, cuenta_pago_id?, observacion?, novedades, enviar? }
router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.empleado_id || !b.anio || !b.mes || !b.fecha_pago) return res.status(400).json({ error: 'Faltan trabajador, año, mes o fecha de pago' });
  const client = await pool.connect();
  let id;
  try {
    await client.query('begin');
    const empleado = await cargarEmpleado(b.empleado_id, client);
    if (!empleado.activo) throw new Error('El trabajador está inactivo');
    const entrada = entradaLiquidacion(empleado, b);
    const L = liquidar(entrada);
    const medio = b.medio_pago || empleado.medio_pago || 'transferencia';
    const cuenta = await resolverCuentaPago(client, { empresa_id: empleado.empresa_id, medio_pago: medio, cuenta_pago_id: b.cuenta_pago_id || null, sentido: 'egreso' });
    const { rows } = await client.query(
      `insert into nomina (empresa_id, empleado_id, anio, mes, periodo, quincena, fecha_pago, medio_pago, cuenta_pago_id, observacion,
                           empleado_snapshot, novedades, liquidacion, total_devengado, total_deducciones, neto, creado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [empleado.empresa_id, empleado.id, entrada.anio, entrada.mes, entrada.periodo, entrada.quincena, b.fecha_pago, medio, cuenta?.id || null,
        b.observacion || null, entrada.empleado, entrada.novedades, L, L.total_devengado, L.total_deducciones, L.neto, req.usuario?.sub]
    );
    id = rows[0].id;
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    const msg = err.code === '23505' ? 'Ese trabajador ya tiene una nómina vigente en ese periodo (anúlala primero si quieres rehacerla)' : err.message;
    return res.status(400).json({ error: msg });
  } finally {
    client.release();
  }
  await contabilizar('nomina', id);
  const dian = b.enviar === false ? null : await enviarNomina(id);
  if (dian?.numero) await contabilizar('nomina', id); // la descripción del asiento lleva el número
  res.status(201).json({ id, dian });
});

router.get('/', async (req, res) => {
  const params = [];
  const where = [];
  for (const [campo, col] of [['empresa_id', 'n.empresa_id'], ['anio', 'n.anio'], ['mes', 'n.mes'], ['empleado_id', 'n.empleado_id']]) {
    if (req.query[campo]) { params.push(req.query[campo]); where.push(`${col} = $${params.length}`); }
  }
  const { rows } = await pool.query(
    `select n.id, n.anio, n.mes, n.periodo, n.quincena, n.fecha_pago, n.medio_pago, n.total_devengado, n.total_deducciones, n.neto,
            n.estado, n.motivo_anulacion, n.estado_dian, n.numero, n.cune, n.dian_mensaje, n.ajuste_numero, e.nombre as empresa,
            trim(concat_ws(' ', n.empleado_snapshot->>'primer_nombre', n.empleado_snapshot->>'primer_apellido', n.empleado_snapshot->>'segundo_apellido')) as empleado,
            n.empleado_snapshot->>'numero_documento' as documento
     from nomina n join empresa e on e.id = n.empresa_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by n.anio desc, n.mes desc, n.creado_en desc limit 500`, params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select n.*, e.nombre as empresa, c.nombre as cuenta_pago from nomina n join empresa e on e.id = n.empresa_id
     left join cuenta_pago c on c.id = n.cuenta_pago_id where n.id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Nómina no encontrada' });
  res.json(rows[0]);
});

router.post('/:id/dian', requireRole('admin'), async (req, res) => {
  try {
    const r = await enviarNomina(req.params.id);
    if (r.numero) await contabilizar('nomina', req.params.id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const { nombre, buffer } = await pdfNomina(req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${nombre.replace(/"/g, '')}"` });
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Anula la nómina. Si ya fue validada por la DIAN, primero se emite la nota de
// ajuste de eliminación; si no, se anula solo en el sistema.
router.post('/:id/anular', requireRole('admin'), async (req, res) => {
  const motivo = String(req.body?.motivo || '').trim();
  if (motivo.length < 5) return res.status(400).json({ error: 'Escribe el motivo de la anulación (mínimo 5 caracteres)' });
  try {
    const { rows } = await pool.query('select * from nomina where id = $1', [req.params.id]);
    const n = rows[0];
    if (!n) throw new Error('Nómina no encontrada');
    if (n.estado === 'anulado') throw new Error('La nómina ya está anulada');
    let ajuste = null;
    if (n.cune) ajuste = await eliminarNominaDian(n);
    await pool.query(
      `update nomina set estado = 'anulado', anulado_en = now(), anulado_por = $2, motivo_anulacion = $3, ajuste_numero = $4, ajuste_cune = $5 where id = $1`,
      [n.id, req.usuario?.sub, motivo, ajuste?.numero || null, ajuste?.cune || null]
    );
    await pool.query(
      `insert into anulacion (documento, documento_id, empresa_id, descripcion, motivo, detalle, usuario_id) values ('nomina', $1, $2, $3, $4, $5, $6)`,
      [n.id, n.empresa_id, `Nómina ${n.numero || ''} ${n.anio}-${String(n.mes).padStart(2, '0')} · ${n.empleado_snapshot.primer_nombre} ${n.empleado_snapshot.primer_apellido}`.replace(/\s+/g, ' '),
        motivo, { ajuste }, req.usuario?.sub]
    );
    await contabilizar('nomina', n.id);
    res.json({ ok: true, documento: 'Nómina', nota_ajuste: ajuste });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- configuración
const publica = (nc) => (nc ? { ...configPublica(nc), misma_cuenta_factura: Boolean(nc.misma_cuenta_factura), usar_empresa_id: nc.usar_empresa_id || null } : null);

router.get('/config/:empresaId', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select nombre, nomina_config, factus_config is not null as tiene_factura from empresa where id = $1', [req.params.empresaId]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  const efectiva = await configNomina(req.params.empresaId);
  res.json({ empresa: rows[0].nombre, tiene_factura: rows[0].tiene_factura, config: publica(rows[0].nomina_config), configurada: Boolean(efectiva), cuenta_de: efectiva?.empresa_cuenta || null, base_url: efectiva?.base_url || null });
});

// body: { modo: 'propia' | 'factura' | 'otra_empresa', usar_empresa_id?, base_url, client_id, client_secret, email, password,
//         numbering_range_id_nomina?, numbering_range_id_ajuste? }
router.put('/config/:empresaId', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select nomina_config from empresa where id = $1', [req.params.empresaId]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  const ant = rows[0].nomina_config || {};
  const b = req.body || {};
  const modo = b.modo || (ant.usar_empresa_id ? 'otra_empresa' : ant.misma_cuenta_factura ? 'factura' : 'propia');
  const rangoId = (campo) => (campo in b ? (String(b[campo] ?? '').trim() || null) : (ant[campo] || null));
  let cfg = { numbering_range_id_nomina: rangoId('numbering_range_id_nomina'), numbering_range_id_ajuste: rangoId('numbering_range_id_ajuste') };
  if (modo === 'otra_empresa') {
    if (!b.usar_empresa_id || b.usar_empresa_id === req.params.empresaId) return res.status(400).json({ error: 'Elige la empresa cuya cuenta de nómina se va a usar' });
    cfg = { usar_empresa_id: b.usar_empresa_id };
  } else if (modo === 'factura') {
    cfg.misma_cuenta_factura = true;
  } else {
    cfg = {
      ...cfg,
      base_url: (b.base_url || ant.base_url || 'https://api-sandbox.factus.com.co').trim().replace(/\/$/, ''),
      client_id: (b.client_id || '').trim() || ant.client_id,
      client_secret: b.client_secret ? String(b.client_secret) : ant.client_secret,
      email: (b.email || '').trim() || ant.email,
      password: b.password ? String(b.password) : ant.password,
    };
    if (!cfg.client_id || !cfg.client_secret || !cfg.email || !cfg.password) return res.status(400).json({ error: 'client_id, client_secret, email y contraseña son obligatorios' });
  }
  await pool.query('update empresa set nomina_config = $1 where id = $2', [cfg, req.params.empresaId]);
  res.json({ ok: true, config: publica(cfg) });
});

router.post('/config/:empresaId/probar', requireRole('admin'), async (req, res) => {
  try {
    const cfg = await configNomina(req.params.empresaId);
    if (!cfg) throw new Error('Primero guarda la cuenta de Factus para nómina');
    res.json(await probarConexionNomina(cfg));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/config/:empresaId/rangos', requireRole('admin'), async (req, res) => {
  try {
    const cfg = await configNomina(req.params.empresaId);
    if (!cfg) throw new Error('Primero guarda la cuenta de Factus para nómina');
    const { documento, prefijo, actual } = req.body || {};
    if (!documento || !prefijo) throw new Error('Faltan documento y prefijo');
    res.status(201).json({ ok: true, rango: await crearRangoNomina(cfg, { documento, prefijo, actual }) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
