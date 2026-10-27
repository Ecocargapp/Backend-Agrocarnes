// Vendedores: maestro para asignar quién hizo cada factura y calcular comisiones.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';

export const router = Router();

// query: empresa_id (devuelve los de esa empresa + los de todas), todos=1 (incluye inactivos)
router.get('/', async (req, res) => {
  const { empresa_id, todos } = req.query;
  const params = []; const w = [];
  if (empresa_id) { params.push(empresa_id); w.push(`(v.empresa_id = $${params.length} or v.empresa_id is null)`); }
  if (!todos) w.push('v.activo');
  const { rows } = await pool.query(
    `select v.*, e.nombre as empresa
     from vendedor v left join empresa e on e.id = v.empresa_id
     ${w.length ? `where ${w.join(' and ')}` : ''} order by v.activo desc, v.nombre`, params
  );
  res.json(rows);
});

function leer(b) {
  const pct = b.comision_pct === undefined || b.comision_pct === '' ? undefined : Number(b.comision_pct);
  if (pct !== undefined && (!Number.isFinite(pct) || pct < 0 || pct > 100)) throw new Error('El % de comisión debe estar entre 0 y 100');
  return {
    nombre: typeof b.nombre === 'string' ? b.nombre.trim() : undefined,
    documento: typeof b.documento === 'string' ? b.documento.trim() || null : undefined,
    telefono: typeof b.telefono === 'string' ? b.telefono.trim() || null : undefined,
    empresa_id: b.empresa_id === undefined ? undefined : b.empresa_id || null,
    comision_pct: pct,
    activo: typeof b.activo === 'boolean' ? b.activo : undefined,
  };
}

const errorDuplicado = (err) => (err.code === '23505' ? 'Ya existe un vendedor con ese documento' : err.message);

// body: { nombre, documento, telefono, empresa_id, comision_pct }
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const v = leer(req.body || {});
    if (!v.nombre) return res.status(400).json({ error: 'El nombre del vendedor es obligatorio' });
    const { rows } = await pool.query(
      `insert into vendedor (nombre, documento, telefono, empresa_id, comision_pct) values ($1, $2, $3, $4, $5) returning *`,
      [v.nombre, v.documento ?? null, v.telefono ?? null, v.empresa_id ?? null, v.comision_pct ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: errorDuplicado(err) });
  }
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  try {
    const v = leer(req.body || {});
    if (v.nombre === '') return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    const campos = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!campos.length) return res.status(400).json({ error: 'Nada que cambiar' });
    const { rows } = await pool.query(
      `update vendedor set ${campos.map(([k], i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`,
      [req.params.id, ...campos.map(([, x]) => x)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: errorDuplicado(err) });
  }
});
