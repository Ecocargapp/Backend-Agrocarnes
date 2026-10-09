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
    if (actual.rows.length === 0 || Number(actual.rows[0].cantidad) < Number(cantidad) - 1e-9) {
      throw new Error('No hay suficiente existencia para esta salida');
    }
    const { cantidad: cantidadActual, costo_promedio: costoActual } = actual.rows[0];
    const nuevaCantidad = Number(cantidadActual) - Number(cantidad);
    // Salida normal: no cambia el costo promedio. Anulación de una entrada: se
    // retira al costo con que entró, para que el valor del inventario quede
    // exactamente como si la entrada no hubiera existido.
    const nuevoCosto = tipo === 'anulacion_entrada' ? costoTrasRetiro(cantidadActual, costoActual, cantidad, costo_unitario) : Number(costoActual);
    await client.query(
      'update existencia set cantidad = $1, costo_promedio = $2, actualizado_en = now() where bodega_id = $3 and producto_id = $4',
      [nuevaCantidad, nuevoCosto, bodega_id, producto_id]
    );
  }

  return rows[0].id;
}

// Costo promedio que queda al retirar `cantidad` valorada a `costo` (reverso de una entrada).
function costoTrasRetiro(cantidadActual, costoActual, cantidad, costo) {
  const resto = Number(cantidadActual) - Number(cantidad);
  if (resto <= 1e-9) return 0;
  const valor = Number(cantidadActual) * Number(costoActual) - Number(cantidad) * Number(costo);
  return valor > 0 ? valor / resto : Number(costoActual);
}

// Recalcula cantidad y costo promedio de cada producto en cada bodega
// reproduciendo todos sus movimientos en orden. Corrige existencias que hayan
// quedado mal valoradas. Devuelve los cambios [{bodega_id, producto_id, antes, despues}].
export async function recalcularExistencias(client, { aplicar = false } = {}) {
  const { rows: movs } = await client.query(
    `select tipo, producto_id, bodega_id, cantidad, costo_unitario from movimiento_inventario order by creado_en, id`
  );
  const estado = new Map();
  for (const m of movs) {
    const k = `${m.bodega_id}|${m.producto_id}`;
    const e = estado.get(k) || { cantidad: 0, costo: 0 };
    const q = Number(m.cantidad); const c = Number(m.costo_unitario);
    if (ENTRADAS.has(m.tipo)) {
      const nueva = e.cantidad + q;
      e.costo = nueva <= 1e-9 ? 0 : (e.cantidad * e.costo + q * c) / nueva;
      e.cantidad = nueva;
    } else {
      if (m.tipo === 'anulacion_entrada') e.costo = costoTrasRetiro(e.cantidad, e.costo, q, c);
      e.cantidad -= q;
      if (e.cantidad <= 1e-9) { e.cantidad = Math.max(0, e.cantidad); if (e.cantidad === 0 && m.tipo === 'anulacion_entrada') e.costo = 0; }
    }
    estado.set(k, e);
  }
  const { rows: actuales } = await client.query('select bodega_id, producto_id, cantidad, costo_promedio from existencia');
  const cambios = [];
  for (const a of actuales) {
    const e = estado.get(`${a.bodega_id}|${a.producto_id}`) || { cantidad: 0, costo: Number(a.costo_promedio) };
    const antes = { cantidad: Number(a.cantidad), costo: Number(a.costo_promedio) };
    if (Math.abs(antes.cantidad - e.cantidad) > 1e-6 || Math.abs(antes.costo - e.costo) > 0.005) {
      cambios.push({ bodega_id: a.bodega_id, producto_id: a.producto_id, antes, despues: { cantidad: e.cantidad, costo: e.costo } });
      if (aplicar) {
        await client.query('update existencia set cantidad = $1, costo_promedio = $2, actualizado_en = now() where bodega_id = $3 and producto_id = $4',
          [e.cantidad, e.costo, a.bodega_id, a.producto_id]);
      }
    }
  }
  return cambios;
}
