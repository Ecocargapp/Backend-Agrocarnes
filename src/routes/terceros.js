import { Router } from 'express';
import { pool } from '../db/pool.js';

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

// Normaliza y valida con las reglas de la plantilla. Devuelve { datos } o { error }.
export function normalizarTercero(b) {
  const d = {};
  d.tipo = ['cliente', 'proveedor', 'ambos'].includes(b.tipo) ? b.tipo : null;
  d.tipo_persona = b.tipo_persona === 'juridica' ? 'juridica' : 'natural';
  d.tipo_documento = texto(b.tipo_documento)?.toUpperCase() || (d.tipo_persona === 'juridica' ? 'NIT' : 'CC');
  d.numero_documento = texto(b.numero_documento)?.replace(/[.\s]/g, '').replace(/-\d$/, '') || null; // sin DV
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

router.post('/', async (req, res) => {
  const { datos, error } = normalizarTercero(req.body || {});
  if (error) return res.status(400).json({ error });
  const { rows: dup } = await pool.query('select nombre from tercero where numero_documento = $1 limit 1', [datos.numero_documento]);
  if (dup[0]) return res.status(409).json({ error: `Ya existe un tercero con ese documento: ${dup[0].nombre}` });
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
  const cols = ['nombre', ...CAMPOS];
  const { rows } = await pool.query(
    `update tercero set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning ${SELECT}`,
    [req.params.id, ...cols.map((c) => datos[c])]
  );
  res.json(rows[0]);
});
