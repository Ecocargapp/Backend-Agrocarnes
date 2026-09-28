import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// /terceros?tipo=proveedor | cliente  (sin tipo devuelve todos)
router.get('/', async (req, res) => {
  const { tipo } = req.query;
  const params = [];
  let where = '';
  if (tipo === 'proveedor' || tipo === 'cliente') {
    params.push(tipo);
    where = `where tipo = $1 or tipo = 'ambos'`;
  }
  const { rows } = await pool.query(
    `select id, tipo, nombre, tipo_documento, numero_documento, email, telefono, direccion, ciudad_id, arco_cliente_id
     from tercero ${where} order by nombre`,
    params
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { tipo, nombre, tipo_documento, numero_documento, email, telefono, direccion, ciudad_id } = req.body;
  if (!tipo || !nombre) return res.status(400).json({ error: 'Faltan tipo o nombre' });
  if (!['cliente', 'proveedor', 'ambos'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo debe ser cliente, proveedor o ambos' });
  }
  const { rows } = await pool.query(
    `insert into tercero (tipo, nombre, tipo_documento, numero_documento, email, telefono, direccion, ciudad_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, tipo, nombre, tipo_documento, numero_documento, email, telefono, direccion, ciudad_id`,
    [tipo, nombre, tipo_documento || null, numero_documento || null, email || null, telefono || null, direccion || null, ciudad_id || null]
  );
  res.status(201).json(rows[0]);
});
