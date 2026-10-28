import { Router } from 'express';
import { pool } from '../db/pool.js';
import { digitoVerificacion } from '../dian/factus.js';

export const router = Router();

// Campos del tercero, los mismos de la plantilla de importación de terceros
// del software contable (Template-7580.xlsx). Ver docs y CHANGELOG.
const CAMPOS = [
  'tipo', 'tipo_persona', 'tipo_documento', 'numero_documento',
  'primer_nombre', 'segundo_nombre', 'primer_apellido', 'segundo_apellido',
  'razon_social', 'nombre_comercial', 'direccion', 'ciudad_id', 'telefono', 'email',
  'autorretenedor_renta', 'regimen_renta', 'limite_rete_renta_facturar', 'limite_rete_renta_comprar',
  'regimen_iva', 'tarifa_rete_iva', 'regimen_ica', 'cuenta_bancaria', 'tipo_cuenta', 'cod_banco',
  'limite_rete_iva_facturar', 'id_exterior', 'activo', 'codigo_pais',
];
const SELECT = `id, nombre, ${CAMPOS.join(', ')}, arco_cliente_id`;

export const TIPOS_DOCUMENTO = { CC: '13', NIT: '31', RC: '11', TI: '12', TE: '21', CE: '22', PA: '41', DE: '42', EX: '43' };
const REGIMEN_RENTA = { natural: ['4', '6', '7', '8', '10'], juridica: ['1', '2', '3', '4', '10'] };
const REGIMEN_IVA = { natural: ['3', '4'], juridica: ['1', '2', '3'] };
const REGIMEN_ICA = { natural: ['2', '3', '4', '5', '8'], juridica: ['1', '2', '6', '7', '8'] };

const texto = (v) => {
  const t = v === undefined || v === null ? '' : String(v).trim();
  return t === '' ? null : t;
};
const booleano = (v, porDefecto) => (v === undefined || v === null || v === '' ? porDefecto : v === true || v === 'true' || v === 'on' || v === '1' || v === 1);

// Valida el número de documento. El NIT va SIN dígito de verificación (la DIAN
// y Factus lo reciben aparte): se rechaza "902033593-9" y también el NIT de
// empresa escrito con el DV pegado ("9020335939").
const NUMERICOS = new Set(['CC', 'NIT', 'TI', 'RC', 'CE', 'TE']);
export function validarDocumento(tipo, numero) {
  if (tipo === 'NIT') {
    if (/-/.test(numero)) return `Escribe el NIT sin el dígito de verificación: ${numero.split('-')[0]} (el sistema calcula el DV solo)`;
    if (!/^\d+$/.test(numero)) return 'El NIT solo lleva números, sin puntos ni letras';
    if (numero.length < 6 || numero.length > 10) return `El NIT ${numero} no es válido: debe tener entre 6 y 10 dígitos, sin el dígito de verificación`;
    if (numero.length === 10 && /^[89]/.test(numero) && digitoVerificacion(numero.slice(0, 9)) === numero[9]) {
      return `Parece que el NIT incluye el dígito de verificación al final. Escríbelo sin él: ${numero.slice(0, 9)}`;
    }
    return null;
  }
  if (NUMERICOS.has(tipo)) {
    if (!/^\d+$/.test(numero)) return 'El número de documento solo lleva números, sin puntos ni guiones';
    if (numero.length < 5 || numero.length > 12) return `El documento ${numero} no es válido: debe tener entre 5 y 12 dígitos`;
  }
  return null;
}

// Normaliza y valida con las reglas de la plantilla. Devuelve { datos } o { error }.
export function normalizarTercero(b) {
  const d = {};
  d.tipo = ['cliente', 'proveedor', 'ambos'].includes(b.tipo) ? b.tipo : null;
  d.tipo_persona = b.tipo_persona === 'juridica' ? 'juridica' : 'natural';
  d.tipo_documento = texto(b.tipo_documento)?.toUpperCase() || (d.tipo_persona === 'juridica' ? 'NIT' : 'CC');
  d.numero_documento = texto(b.numero_documento)?.replace(/[.,\s]/g, '') || null; // sin DV
  for (const c of ['primer_nombre', 'segundo_nombre', 'primer_apellido', 'segundo_apellido', 'razon_social', 'nombre_comercial',
    'direccion', 'ciudad_id', 'telefono', 'email', 'cuenta_bancaria', 'cod_banco', 'id_exterior']) d[c] = texto(b[c]);
  d.autorretenedor_renta = d.tipo_persona === 'juridica' && booleano(b.autorretenedor_renta, false);
  d.regimen_renta = texto(b.regimen_renta);
  d.regimen_iva = texto(b.regimen_iva);
  d.regimen_ica = texto(b.regimen_ica);
  d.tipo_cuenta = ['27', '37'].includes(String(b.tipo_cuenta)) ? String(b.tipo_cuenta) : null;
  for (const c of ['limite_rete_renta_facturar', 'limite_rete_renta_comprar', 'limite_rete_iva_facturar']) d[c] = b[c] === 'cualquier' ? 'cualquier' : 'legal';
  d.tarifa_rete_iva = Number(b.tarifa_rete_iva) || 0;
  d.activo = booleano(b.activo, true);
  d.codigo_pais = texto(b.codigo_pais) || '169';

  if (!d.tipo) return { error: 'tipo debe ser cliente, proveedor o ambos' };
  if (!TIPOS_DOCUMENTO[d.tipo_documento]) return { error: `Tipo de documento no válido: ${d.tipo_documento}` };
  if (!d.numero_documento) return { error: 'Falta el número de identificación (sin dígito de verificación)' };
  const errDoc = validarDocumento(d.tipo_documento, d.numero_documento);
  if (errDoc) return { error: errDoc };
  if (d.tipo_persona === 'natural') {
    if (!d.primer_nombre || !d.primer_apellido) return { error: 'Persona natural: primer nombre y primer apellido son obligatorios' };
    d.razon_social = null;
  } else if (!d.razon_social) {
    return { error: 'Persona jurídica: la razón social es obligatoria' };
  }
  if (!d.direccion || d.direccion.length < 8) return { error: 'La dirección es obligatoria y debe tener al menos 8 caracteres' };
  if (!d.ciudad_id || !/^\d{5}$/.test(d.ciudad_id)) return { error: 'Código de ciudad DANE obligatorio, de 5 dígitos (ej. 05001 Medellín)' };
  if (!d.telefono) return { error: 'El teléfono es obligatorio' };
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return { error: 'Correo electrónico no válido' };
  if (d.regimen_renta && !REGIMEN_RENTA[d.tipo_persona].includes(d.regimen_renta)) return { error: 'Régimen de renta no válido para el tipo de persona' };
  if (d.regimen_iva && !REGIMEN_IVA[d.tipo_persona].includes(d.regimen_iva)) return { error: 'Régimen de IVA no válido para el tipo de persona' };
  if (d.regimen_ica && !REGIMEN_ICA[d.tipo_persona].includes(d.regimen_ica)) return { error: 'Régimen de ICA no válido para el tipo de persona' };

  d.nombre = d.tipo_persona === 'juridica'
    ? d.razon_social
    : [d.primer_nombre, d.segundo_nombre, d.primer_apellido, d.segundo_apellido].filter(Boolean).join(' ');
  return { datos: d };
}

// /terceros?tipo=proveedor | cliente  (sin tipo devuelve todos)
router.get('/', async (req, res) => {
  const { tipo } = req.query;
  const params = [];
  let where = '';
  if (tipo === 'proveedor' || tipo === 'cliente') {
    params.push(tipo);
    where = `where tipo = $1 or tipo = 'ambos'`;
  }
  const { rows } = await pool.query(`select ${SELECT} from tercero ${where} order by nombre`, params);
  res.json(rows);
});

// Habilita un tercero existente con el otro rol: body { numero_documento, rol: cliente | proveedor }.
router.post('/habilitar', async (req, res) => {
  const doc = String(req.body?.numero_documento || '').replace(/[.\s]/g, '').replace(/-\d$/, '');
  const rol = req.body?.rol;
  if (!doc || !['cliente', 'proveedor'].includes(rol)) return res.status(400).json({ error: 'Escribe el NIT o la cédula' });
  const { rows } = await pool.query(`select ${SELECT} from tercero where regexp_replace(numero_documento, '[.\\s]', '', 'g') = $1 limit 1`, [doc]);
  const t = rows[0];
  if (!t) return res.status(404).json({ error: `No hay ningún tercero con el documento ${doc}. Créalo con el formulario.` });
  const tipo = t.tipo === rol || t.tipo === 'ambos' ? t.tipo : 'ambos';
  const { rows: act } = await pool.query(`update tercero set tipo = $2 where id = $1 returning ${SELECT}`, [t.id, tipo]);
  res.json({ ...act[0], existente: true, promovido: tipo !== t.tipo });
});

router.post('/', async (req, res) => {
  const { datos, error } = normalizarTercero(req.body || {});
  if (error) return res.status(400).json({ error });
  if (req.body?.tambien === true || req.body?.tambien === 'true' || req.body?.tambien === 'on') datos.tipo = 'ambos';
  // Si el NIT ya existe, no se duplica: se usa el mismo tercero y, si era solo
  // cliente (o solo proveedor), pasa a ser cliente y proveedor ("ambos"). Los
  // datos que le faltaban se completan con los del formulario; los que ya
  // tenía no se tocan.
  const { rows: dup } = await pool.query(`select ${SELECT} from tercero where regexp_replace(numero_documento, '[.\\s]', '', 'g') = $1 limit 1`, [datos.numero_documento]);
  if (dup[0]) {
    const t = dup[0];
    const tipo = t.tipo === datos.tipo || t.tipo === 'ambos' ? t.tipo : 'ambos';
    const completar = CAMPOS.filter((c) => c !== 'tipo' && (t[c] === null || t[c] === '') && datos[c] !== null && datos[c] !== undefined && datos[c] !== '');
    const sets = ['tipo = $2', ...completar.map((c, i) => `${c} = $${i + 3}`)];
    const { rows } = await pool.query(
      `update tercero set ${sets.join(', ')} where id = $1 returning ${SELECT}`,
      [t.id, tipo, ...completar.map((c) => datos[c])]
    );
    return res.status(200).json({ ...rows[0], existente: true, promovido: tipo !== t.tipo });
  }
  const cols = ['nombre', ...CAMPOS];
  const { rows } = await pool.query(
    `insert into tercero (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning ${SELECT}`,
    cols.map((c) => datos[c])
  );
  res.status(201).json(rows[0]);
});

// Edita un tercero (se envían todos sus campos, con las mismas reglas de la creación).
router.put('/:id', async (req, res) => {
  const { rows: act } = await pool.query(`select ${SELECT} from tercero where id = $1`, [req.params.id]);
  if (!act[0]) return res.status(404).json({ error: 'Tercero no encontrado' });
  const { datos, error } = normalizarTercero({ ...act[0], ...req.body });
  if (error) return res.status(400).json({ error });
  if (req.body?.tambien !== undefined) {
    const tambien = req.body.tambien === true || req.body.tambien === 'true';
    if (tambien) datos.tipo = 'ambos';
    else if (act[0].tipo === 'ambos' && ['cliente', 'proveedor'].includes(req.body.rol)) datos.tipo = req.body.rol;
  }
  const { rows: dup } = await pool.query(
    `select nombre from tercero where regexp_replace(numero_documento, '[.\\s]', '', 'g') = $1 and id <> $2 limit 1`, [datos.numero_documento, req.params.id]
  );
  if (dup[0]) return res.status(400).json({ error: `Ya existe otro tercero con el documento ${datos.numero_documento}: ${dup[0].nombre}` });
  const cols = ['nombre', ...CAMPOS];
  const { rows } = await pool.query(
    `update tercero set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning ${SELECT}`,
    [req.params.id, ...cols.map((c) => datos[c])]
  );
  res.json(rows[0]);
});

// Cambia solo el tipo de un tercero (cliente | proveedor | ambos).
router.patch('/:id/tipo', async (req, res) => {
  const tipo = req.body?.tipo;
  if (!['cliente', 'proveedor', 'ambos'].includes(tipo)) return res.status(400).json({ error: 'tipo debe ser cliente, proveedor o ambos' });
  const { rows } = await pool.query(`update tercero set tipo = $2 where id = $1 returning ${SELECT}`, [req.params.id, tipo]);
  if (!rows[0]) return res.status(404).json({ error: 'Tercero no encontrado' });
  res.json(rows[0]);
});
