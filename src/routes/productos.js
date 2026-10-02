import { Router } from 'express';
import { pool } from '../db/pool.js';

export const router = Router();

// Lista productos, opcionalmente filtrados por empresa: /productos?empresa_id=...
router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let sql = 'select id, empresa_id, codigo, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code, precio_venta, maneja_inventario, tipo_impuesto from producto';
  if (empresa_id) {
    params.push(empresa_id);
    sql += ' where empresa_id = $1';
  }
  sql += ' order by codigo nulls last, nombre';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code, precio_venta, maneja_inventario, tipo_impuesto } = req.body;
  if (!empresa_id || !nombre || !tipo || !unidad_medida) {
    return res.status(400).json({ error: 'Faltan campos: empresa_id, nombre, tipo, unidad_medida' });
  }
  const sinInventario = maneja_inventario === false || maneja_inventario === 'false';
  let codigo = req.body.codigo?.trim().toUpperCase() || null;
  // Platos del menú / servicios sin código: el siguiente A0001, A0002… de la empresa.
  if (!codigo && sinInventario) {
    const { rows: ult } = await pool.query(
      `select coalesce(max(substring(upper(codigo) from '^A(\\d+)$')::int), 0) + 1 as n from producto where empresa_id = $1`, [empresa_id]
    );
    codigo = `A${String(ult[0].n).padStart(4, '0')}`;
  }
  if (codigo) {
    const { rows: dup } = await pool.query('select nombre from producto where empresa_id = $1 and upper(codigo) = $2', [empresa_id, codigo]);
    if (dup[0]) return res.status(409).json({ error: `El código ${codigo} ya lo tiene "${dup[0].nombre}"` });
  }
  const { rows } = await pool.query(
    `insert into producto (empresa_id, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code, precio_venta, maneja_inventario, tipo_impuesto, codigo)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id, empresa_id, codigo, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code, precio_venta, maneja_inventario, tipo_impuesto`,
    [empresa_id, nombre, tipo, unidad_medida, arco_producto_id?.trim() || null, Number(impuesto_pct) || 0, factus_unidad_medida_code?.trim() || null, factus_estandar_code?.trim() || '999',
     precio_venta === undefined || precio_venta === '' ? null : Number(precio_venta),
     maneja_inventario === undefined ? true : maneja_inventario === true || maneja_inventario === 'true' || maneja_inventario === 'on',
     tipo_impuesto === 'INC' ? 'INC' : 'IVA', codigo]
  );
  res.status(201).json(rows[0]);
});

// Actualiza nombre, códigos Arco/Factus, impuesto, precio de venta y si maneja inventario.
router.patch('/:id', async (req, res) => {
  const { nombre, arco_producto_id, impuesto_pct, tipo, unidad_medida, factus_unidad_medida_code, factus_estandar_code, precio_venta, maneja_inventario, tipo_impuesto } = req.body;
  const codigo = req.body.codigo === undefined || req.body.codigo === null ? null : String(req.body.codigo).trim().toUpperCase();
  if (codigo) {
    const { rows: dup } = await pool.query(
      'select nombre from producto where empresa_id = (select empresa_id from producto where id = $1) and upper(codigo) = $2 and id <> $1', [req.params.id, codigo]
    );
    if (dup[0]) return res.status(409).json({ error: `El código ${codigo} ya lo tiene "${dup[0].nombre}"` });
  }
  const { rows } = await pool.query(
    `update producto set
       nombre = coalesce($2, nombre),
       arco_producto_id = case when $3::text is null then arco_producto_id else nullif(trim($3), '') end,
       impuesto_pct = coalesce($4, impuesto_pct),
       tipo = coalesce($5, tipo),
       unidad_medida = coalesce($6, unidad_medida),
       factus_unidad_medida_code = case when $7::text is null then factus_unidad_medida_code else nullif(trim($7), '') end,
       factus_estandar_code = coalesce(nullif(trim($8), ''), factus_estandar_code),
       precio_venta = case when $9::text is null then precio_venta else nullif(trim($9), '')::numeric end,
       maneja_inventario = coalesce($10, maneja_inventario),
       tipo_impuesto = coalesce($11, tipo_impuesto),
       codigo = case when $12::text is null then codigo else nullif($12, '') end
     where id = $1
     returning id, empresa_id, codigo, nombre, tipo, unidad_medida, arco_producto_id, impuesto_pct, factus_unidad_medida_code, factus_estandar_code, precio_venta, maneja_inventario, tipo_impuesto`,
    [req.params.id, nombre ?? null, arco_producto_id ?? null, impuesto_pct === undefined ? null : Number(impuesto_pct), tipo ?? null, unidad_medida ?? null, factus_unidad_medida_code ?? null, factus_estandar_code ?? null,
     precio_venta === undefined || precio_venta === null ? null : String(precio_venta),
     maneja_inventario === undefined ? null : maneja_inventario === true || maneja_inventario === 'true',
     tipo_impuesto === 'INC' || tipo_impuesto === 'IVA' ? tipo_impuesto : null, codigo]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(rows[0]);
});
