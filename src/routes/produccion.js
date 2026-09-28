import { Router } from 'express';
import { pool } from '../db/pool.js';
import { registrarMovimiento } from '../db/inventario.js';

export const router = Router();

// Corre una receta (BOM): consume los insumos y entra el producto terminado.
// El costo del terminado = suma del costo de los insumos consumidos.
// body: { empresa_id, producto_terminado_id, cantidad_producida, bodega_id }
router.post('/', async (req, res) => {
  const { empresa_id, producto_terminado_id, cantidad_producida, bodega_id } = req.body;
  if (!empresa_id || !producto_terminado_id || !cantidad_producida || !bodega_id) {
    return res.status(400).json({ error: 'Faltan empresa_id, producto_terminado_id, cantidad_producida o bodega_id' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const { rows: receta } = await client.query(
      'select producto_insumo_id, cantidad_por_unidad from receta where producto_terminado_id = $1',
      [producto_terminado_id]
    );
    if (receta.length === 0) throw new Error('Este producto no tiene receta configurada');

    const { rows: ordenRows } = await client.query(
      `insert into orden_produccion (empresa_id, producto_terminado_id, cantidad_producida, bodega_id, creado_por)
       values ($1, $2, $3, $4, $5) returning id`,
      [empresa_id, producto_terminado_id, cantidad_producida, bodega_id, req.usuario?.sub]
    );
    const ordenId = ordenRows[0].id;

    let costoTotalTerminado = 0;
    for (const insumo of receta) {
      const cantidadNecesaria = Number(insumo.cantidad_por_unidad) * Number(cantidad_producida);

      const { rows: existRows } = await client.query(
        'select costo_promedio from existencia where bodega_id = $1 and producto_id = $2',
        [bodega_id, insumo.producto_insumo_id]
      );
      if (existRows.length === 0) throw new Error(`Sin existencia del insumo ${insumo.producto_insumo_id} en esta bodega`);
      const costoUnitario = existRows[0].costo_promedio;

      await registrarMovimiento(client, {
        tipo: 'produccion_consumo', producto_id: insumo.producto_insumo_id, bodega_id,
        cantidad: cantidadNecesaria, costo_unitario: costoUnitario,
        referencia_tipo: 'orden_produccion', referencia_id: ordenId, creado_por: req.usuario?.sub,
      });
      costoTotalTerminado += cantidadNecesaria * Number(costoUnitario);
    }

    const costoUnitarioTerminado = costoTotalTerminado / Number(cantidad_producida);
    await registrarMovimiento(client, {
      tipo: 'produccion_entrada', producto_id: producto_terminado_id, bodega_id,
      cantidad: cantidad_producida, costo_unitario: costoUnitarioTerminado,
      referencia_tipo: 'orden_produccion', referencia_id: ordenId, creado_por: req.usuario?.sub,
    });

    await client.query('commit');
    res.status(201).json({ id: ordenId, costo_unitario_terminado: costoUnitarioTerminado });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});
