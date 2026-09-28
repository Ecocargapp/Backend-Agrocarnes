import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Todas las bodegas con el nombre de su empresa, para los selectores.
router.get('/', async (_req, res) => {
  const { rows } = await pool.query(`
    select b.id, b.nombre, b.empresa_id, e.nombre as empresa
    from bodega b join empresa e on e.id = b.empresa_id
    order by e.nombre, b.nombre
  `);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { empresa_id, nombre } = req.body;
  if (!empresa_id || !nombre) return res.status(400).json({ error: 'Faltan empresa_id o nombre' });
  const { rows } = await pool.query(
    'insert into bodega (empresa_id, nombre) values ($1, $2) returning id, empresa_id, nombre',
    [empresa_id, nombre]
  );
  res.status(201).json(rows[0]);
});
