// Administración de usuarios (solo admin).
// Roles:
//   admin       → todo (configuración, nómina, informes contables, anulaciones).
//   operador    → punto de venta: facturar, comprar, gastos, traslados,
//                 producción, recibos de caja, egresos y la venta diaria.
//                 No anula documentos, no ve nómina ni informes contables.
// Si el usuario tiene empresa_id, solo ve esa empresa.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';

export const router = Router();
export const ROLES = ['admin', 'operador'];

const COLUMNAS = `u.id, u.nombre, u.email, u.rol, u.activo, u.empresa_id, e.nombre as empresa, u.creado_en`;

router.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `select ${COLUMNAS} from usuario u left join empresa e on e.id = u.empresa_id order by u.activo desc, u.nombre`
  );
  res.json(rows);
});

function validar({ email, rol, password }, nuevo) {
  if (nuevo && !/^\S+@\S+\.\S+$/.test(email || '')) return 'Correo inválido';
  if (rol !== undefined && !ROLES.includes(rol)) return 'Rol inválido';
  if ((nuevo || password) && String(password || '').length < 4) return 'La contraseña debe tener al menos 4 caracteres';
  return null;
}

router.post('/', async (req, res) => {
  const { nombre, email, password, rol = 'operador', empresa_id } = req.body;
  const error = validar({ email, rol, password }, true);
  if (error) return res.status(400).json({ error });
  const hash = await bcrypt.hash(String(password), 10);
  try {
    const { rows } = await pool.query(
      `insert into usuario (nombre, email, password_hash, rol, empresa_id) values ($1, lower($2), $3, $4, $5) returning id`,
      [nombre || email, email.trim(), hash, rol, empresa_id || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  const { nombre, rol, empresa_id, activo, password } = req.body;
  const error = validar({ rol, password }, false);
  if (error) return res.status(400).json({ error });
  if (req.params.id === req.usuario.sub && (activo === false || (rol && rol !== 'admin'))) {
    return res.status(400).json({ error: 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo' });
  }
  const hash = password ? await bcrypt.hash(String(password), 10) : null;
  const { rowCount } = await pool.query(
    `update usuario set
       nombre = coalesce($2, nombre),
       rol = coalesce($3, rol),
       empresa_id = case when $4::boolean then $5::uuid else empresa_id end,
       activo = coalesce($6, activo),
       password_hash = coalesce($7, password_hash)
     where id = $1`,
    [req.params.id, nombre || null, rol || null, empresa_id !== undefined, empresa_id || null,
      typeof activo === 'boolean' ? activo : null, hash]
  );
  if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true });
});
