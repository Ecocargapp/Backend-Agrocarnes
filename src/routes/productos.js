import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Lista productos, opcionalmente filtrados por empresa: /productos?empresa_id=...
router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let sql = 'select id, empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code from producto';
  if (empresa_id) {
    params.push(empresa_id);
    sql += ' where empresa_id = $1';
  }
  sql += ' order by nombre';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code } = req.body;
  if (!empresa_id || !nombre || !tipo || !unidad_medida) {
    return res.status(400).json({ error: 'Faltan campos: empresa_id, nombre, tipo, unidad_medida' });
  }
  const { rows } = await pool.query(
    `insert into producto (empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code`,
    [empresa_id, nombre, tipo, unidad_medida, arco_producto_id?.trim() || null, Number(impuesto_pct) || 0, factus_unidad_medida_code?.trim() || null, factus_estandar_code?.trim() || '999']
  );
  res.status(201).json(rows[0]);
});

// Actualiza nombre, código Arco/Factus y % de impuesto.
router.patch('/:id', async (req, res) => {
  const { nombre, arco_producto_id, impuesto_pct, tipo, unidad_medida, factus_unidad_medida_code, factus_estandar_code } = req.body;
  const { rows } = await pool.query(
    `update producto set
       nombre = coalesce($2, nombre),
       arco_producto_id = case when $3::text is null then arco_producto_id else nullif(trim($3), '') end,
       impuesto_pct = coalesce($4, impuesto_pct),
       tipo = coalesce($5, tipo),
       unidad_medida = coalesce($6, unidad_medida),
       factus_unidad_medida_code = case when $7::text is null then factus_unidad_medida_code else nullif(trim($7), '') end,
       factus_estandar_code = coalesce(nullif(trim($8), ''), factus_estandar_code)
     where id = $1
     returning id, empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code`,
    [req.params.id, nombre ?? null, arco_producto_id ?? null, impuesto_pct === undefined ? null : Number(impuesto_pct), tipo ?? null, unidad_medida ?? null, factus_unidad_medida_code ?? null, factus_estandar_code ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(rows[0]);
});
