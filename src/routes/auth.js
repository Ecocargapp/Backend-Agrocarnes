import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';

export const router = Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Falta email o password' });
  }

  const { rows } = await pool.query(
    'select id, empresa_id, nombre, email, password_hash, rol, activo from usuario where lower(email) = lower($1)',
    [String(email).trim()]
  );
  const usuario = rows[0];
  if (!usuario || !usuario.activo) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  const ok = await bcrypt.compare(password, usuario.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = jwt.sign(
    { sub: usuario.id, empresa_id: usuario.empresa_id, rol: usuario.rol },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );

  res.json({
    token,
    usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol, empresa_id: usuario.empresa_id },
  });
});
