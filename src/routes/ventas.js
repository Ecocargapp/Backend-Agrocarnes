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
  let consecutivo;
  try {
    await client.query('begin');

    // Consecutivo por empresa (bloqueando la fila para que no se repita).
    const { rows: empRows } = await client.query(
      `update empresa set ultimo_consecutivo = ultimo_consecutivo + 1
       where id = $1 returning prefijo_factura, ultimo_consecutivo`,
      [empresa_id]
    );
    if (!empRows[0]) throw new Error('Empresa no encontrada');
    consecutivo = `${empRows[0].prefijo_factura || 'FV'}-${String(empRows[0].ultimo_consecutivo).padStart(6, '0')}`;

    const total = items.reduce((acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario), 0);
    const { rows: facturaRows } = await client.query(
      `insert into factura_venta (empresa_id, cliente_id, consecutivo, total)
       values ($1, $2, $3, $4) returning id`,
      [empresa_id, cliente_id || null, consecutivo, total]
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

  res.status(201).json({ id: facturaId, consecutivo });
});

router.get('/', async (req, res) => {
  const { empresa_id } = req.query;
  const params = [];
  let where = '';
  if (empresa_id) { params.push(empresa_id); where = 'where f.empresa_id = $1'; }
  const { rows } = await pool.query(
    `select f.id, f.consecutivo, f.fecha, f.total, f.estado_dian, f.cufe,
            e.nombre as empresa, t.nombre as cliente,
            (select count(*)::int from factura_venta_item i where i.factura_venta_id = f.id) as items
     from factura_venta f
     join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id
     ${where}
     order by f.fecha desc limit 200`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select f.*, e.nombre as empresa, t.nombre as cliente
     from factura_venta f join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id where f.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
  const { rows: items } = await pool.query(
    `select i.cantidad, i.precio_unitario, p.nombre as producto, p.unidad_medida
     from factura_venta_item i join producto p on p.id = i.producto_id
     where i.factura_venta_id = $1 order by p.nombre`,
    [req.params.id]
  );
  res.json({ ...rows[0], items });
});
