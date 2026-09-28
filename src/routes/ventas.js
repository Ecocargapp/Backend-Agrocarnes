import { Router } from 'express';
import { pool } from '../db/pool.js';
import { registrarMovimiento } from '../db/inventario.js';
import { enviarFacturaADian } from '../dian/cliente.js';

export const router = Router();

// Vende al cliente final (mostrador Agrocarnes o consumo del Restaurante).
// body: { empresa_id, cliente_id, bodega_id, items: [{producto_id, cantidad, precio_unitario}] }
router.post('/', async (req, res) => {
  const { empresa_id, cliente_id, bodega_id, items } = req.body;
  if (!empresa_id || !bodega_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Faltan empresa_id, bodega_id o items' });
  }

  const client = await pool.connect();
  let facturaId;
  try {
    await client.query('begin');

    const total = items.reduce((acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario), 0);
    const { rows: facturaRows } = await client.query(
      `insert into factura_venta (empresa_id, cliente_id, total)
       values ($1, $2, $3) returning id`,
      [empresa_id, cliente_id || null, total]
    );
    facturaId = facturaRows[0].id;

    for (const item of items) {
      await client.query(
        `insert into factura_venta_item (factura_venta_id, producto_id, cantidad, precio_unitario)
         values ($1, $2, $3, $4)`,
        [facturaId, item.producto_id, item.cantidad, item.precio_unitario]
      );

      const { rows: existRows } = await client.query(
        'select costo_promedio from existencia where bodega_id = $1 and producto_id = $2',
        [bodega_id, item.producto_id]
      );
      const costoUnitario = existRows[0]?.costo_promedio ?? 0;

      await registrarMovimiento(client, {
        tipo: 'venta', producto_id: item.producto_id, bodega_id, cantidad: item.cantidad, costo_unitario: costoUnitario,
        referencia_tipo: 'factura_venta', referencia_id: facturaId, creado_por: req.usuario?.sub,
      });
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }

  // La venta ya quedó registrada y el cliente puede recibir su recibo YA:
  // el envío a la DIAN pasa en segundo plano y no debe bloquear la venta.
  enviarFacturaADian(facturaId).catch((err) => {
    console.error(`No se pudo enviar la factura ${facturaId} a la DIAN:`, err.message);
  });

  res.status(201).json({ id: facturaId });
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('select * from factura_venta where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(rows[0]);
});
