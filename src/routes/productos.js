import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Lista productos, opcionalmente filtrados por empresa: /productos?empresa_id=...
router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let sql = 'select id, empresa_id, nombre, tipo, unidad_medida from producto';
  if (empresa_id) {
    params.push(empresa_id);
    sql += ' where empresa_id = $1';
  }
  sql += ' order by nombre';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { empresa_id, nombre, tipo, unidad_medida } = req.body;
  if (!empresa_id || !nombre || !tipo || !unidad_medida) {
    return res.status(400).json({ error: 'Faltan campos: empresa_id, nombre, tipo, unidad_medida' });
  }
  const { rows } = await pool.query(
    `insert into producto (empresa_id, nombre, tipo, unidad_medida)
     values ($1, $2, $3, $4) returning id, empresa_id, nombre, tipo, unidad_medida`,
    [empresa_id, nombre, tipo, unidad_medida]
  );
  res.status(201).json(rows[0]);
});
