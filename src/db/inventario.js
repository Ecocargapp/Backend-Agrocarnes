// Lógica central de inventario: TODO movimiento de cantidad pasa por aquí,
// para que "existencia" y "movimiento_inventario" nunca queden desincronizados.
// Se usa dentro de una transacción (recibe el `client`, no el pool).

const ENTRADAS = new Set(['compra', 'porcionado_entrada', 'traslado_entrada', 'produccion_entrada', 'devolucion_venta', 'anulacion_venta', 'anulacion_salida']);
const SALIDAS = new Set(['porcionado_salida', 'traslado_salida', 'produccion_consumo', 'venta', 'anulacion_entrada']);
export const TIPOS_ENTRADA = ENTRADAS;

export async function registrarMovimiento(client, {
  tipo, producto_id, bodega_id, cantidad, costo_unitario,
  referencia_tipo = null, referencia_id = null, creado_por = null,
}) {
  if (!ENTRADAS.has(tipo) && !SALIDAS.has(tipo)) {
    throw new Error(`Tipo de movimiento desconocido: ${tipo}`);
  }
  if (cantidad <= 0) throw new Error('La cantidad debe ser mayor que cero');

  const { rows } = await client.query(
    `insert into movimiento_inventario
       (tipo, producto_id, bodega_id, cantidad, costo_unitario, referencia_tipo, referencia_id, creado_por)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [tipo, producto_id, bodega_id, cantidad, costo_unitario, referencia_tipo, referencia_id, creado_por]
  );

  const actual = await client.query(
    'select cantidad, costo_promedio from existencia where bodega_id = $1 and producto_id = $2 for update',
    [bodega_id, producto_id]
  );

  if (ENTRADAS.has(tipo)) {
    if (actual.rows.length === 0) {
      await client.query(
        `insert into existencia (bodega_id, producto_id, cantidad, costo_promedio)
         values ($1, $2, $3, $4)`,
        [bodega_id, producto_id, cantidad, costo_unitario]
      );
    } else {
      const { cantidad: cantidadActual, costo_promedio: costoActual } = actual.rows[0];
      const nuevaCantidad = Number(cantidadActual) + Number(cantidad);
      // Costo promedio ponderado: (stock viejo * costo viejo + entrada * costo entrada) / stock nuevo
      const nuevoCosto = nuevaCantidad === 0 ? 0 :
        (Number(cantidadActual) * Number(costoActual) + Number(cantidad) * Number(costo_unitario)) / nuevaCantidad;
      await client.query(
        'update existencia set cantidad = $1, costo_promedio = $2, actualizado_en = now() where bodega_id = $3 and producto_id = $4',
        [nuevaCantidad, nuevoCosto, bodega_id, producto_id]
      );
    }
  } else {
    // Salida: no cambia el costo promedio, solo resta cantidad.
    if (actual.rows.length === 0 || Number(actual.rows[0].cantidad) < Number(cantidad)) {
      throw new Error('No hay suficiente existencia para esta salida');
    }
    await client.query(
      'update existencia set cantidad = cantidad - $1, actualizado_en = now() where bodega_id = $2 and producto_id = $3',
      [cantidad, bodega_id, producto_id]
    );
  }

  return rows[0].id;
}
