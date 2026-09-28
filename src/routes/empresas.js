import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

router.get('/', async (_req, res) => {
  const { rows } = await pool.query('select id, nombre, nit, es_facturador_dian from empresa order by nombre');
  res.json(rows);
});
