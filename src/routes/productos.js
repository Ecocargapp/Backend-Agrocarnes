import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Lista productos, opcionalmente filtrados por empresa: /productos?empresa_id=...
router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let sql = 'select id, empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct from producto';
  if (empresa_id) {
    params.push(empresa_id);
    sql += ' where empresa_id = $1';
  }
  sql += ' order by nombre';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct } = req.body;
  if (!empresa_id || !nombre || !tipo || !unidad_medida) {
    return res.status(400).json({ error: 'Faltan campos: empresa_id, nombre, tipo, unidad_medida' });
  }
  const { rows } = await pool.query(
    `insert into producto (empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct)
     values ($1, $2, $3, $4, $5, $6) returning id, empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct`,
    [empresa_id, nombre, tipo, unidad_medida, arco_producto_id?.trim() || null, Number(impuesto_pct) || 0]
  );
  res.status(201).json(rows[0]);
});

// Actualiza nombre, código Arco y % de impuesto.
router.patch('/:id', async (req, res) => {
  const { nombre, arco_producto_id, impuesto_pct, tipo, unidad_medida } = req.body;
  const { rows } = await pool.query(
    `update producto set
       nombre = coalesce($2, nombre),
       arco_producto_id = case when $3::text is null then arco_producto_id else nullif(trim($3), '') end,
       impuesto_pct = coalesce($4, impuesto_pct),
       tipo = coalesce($5, tipo),
       unidad_medida = coalesce($6, unidad_medida)
     where id = $1
     returning id, empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct`,
    [req.params.id, nombre ?? null, arco_producto_id ?? null, impuesto_pct === undefined ? null : Number(impuesto_pct), tipo ?? null, unidad_medida ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(rows[0]);
});
