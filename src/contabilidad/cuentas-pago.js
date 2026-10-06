// Cuentas de pago (cajas, bancos, tarjetas de crédito) y registro de egresos.
//
// Un EGRESO es un pago_proveedor: sale dinero de una cuenta de pago hacia un
// proveedor, aplicado a una o varias compras/gastos. Lo usan Compras y Gastos
// de contado y los pagos de Cartera, así todos quedan con su comprobante de
// egreso numerado, medio de pago y cuenta de origen.

export const MEDIOS_PAGO = {
  efectivo:        { nombre: 'Efectivo',               tipos: ['caja'] },
  transferencia:   { nombre: 'Transferencia',          tipos: ['banco'] },
  pse:             { nombre: 'PSE',                    tipos: ['banco'] },
  consignacion:    { nombre: 'Consignación',           tipos: ['banco'] },
  cheque:          { nombre: 'Cheque',                 tipos: ['banco'] },
  tarjeta_debito:  { nombre: 'Tarjeta débito',         tipos: ['banco'] },
  tarjeta_credito: { nombre: 'Tarjeta de crédito',     tipos: ['tarjeta_credito', 'banco'] }, // en recibos, el datáfono abona al banco
  tarjeta:         { nombre: 'Tarjeta',                tipos: ['banco'] },                    // registros anteriores
  otro:            { nombre: 'Otro',                   tipos: ['caja', 'banco', 'tarjeta_credito'] },
};

// Siguiente subcuenta libre: bancos 111005NN, tarjetas 210510NN.
export async function siguienteCuentaContable(client, tipo) {
  if (tipo === 'caja') return '110505';
  const prefijo = tipo === 'banco' ? '111005' : '210510';
  const { rows } = await client.query(
    `select coalesce(max(substring(codigo from 7)::int), 0) + 1 as n from cuenta where codigo ~ $1`, [`^${prefijo}\\d{2}$`]
  );
  return `${prefijo}${String(rows[0].n).padStart(2, '0')}`;
}

// Valida y devuelve la cuenta de pago. Si no viene, usa la caja (efectivo) o
// la única cuenta bancaria de la empresa; si hay varias, la exige.
export async function resolverCuentaPago(client, { empresa_id, medio_pago, cuenta_pago_id, sentido = 'egreso' }) {
  const medio = MEDIOS_PAGO[medio_pago] ? medio_pago : 'otro';
  let tipos = MEDIOS_PAGO[medio].tipos;
  if (sentido === 'ingreso' && medio === 'tarjeta_credito') tipos = ['banco'];
  if (sentido === 'egreso' && medio === 'tarjeta_credito') tipos = ['tarjeta_credito'];
  if (cuenta_pago_id) {
    const { rows } = await client.query('select * from cuenta_pago where id = $1', [cuenta_pago_id]);
    const c = rows[0];
    if (!c || c.empresa_id !== empresa_id) throw new Error('La cuenta de pago no es de esta empresa');
    if (!c.activa) throw new Error(`La cuenta "${c.nombre}" está inactiva`);
    if (!tipos.includes(c.tipo)) {
      throw new Error(`Con ${MEDIOS_PAGO[medio].nombre.toLowerCase()} la cuenta debe ser ${tipos.map((t) => ({ caja: 'una caja', banco: 'una cuenta bancaria', tarjeta_credito: 'una tarjeta de crédito' })[t]).join(' o ')}`);
    }
    return c;
  }
  const { rows } = await client.query(
    'select * from cuenta_pago where empresa_id = $1 and activa and tipo = any($2) order by creado_en', [empresa_id, tipos]
  );
  if (rows.length === 1) return rows[0];
  if (!rows.length) {
    if (tipos.includes('caja')) throw new Error('La empresa no tiene caja configurada (Configuración → Cajas y cuentas bancarias)');
    return null; // sin cuentas bancarias configuradas: se contabiliza en 1110 genérica
  }
  throw new Error(`Elige de qué cuenta ${sentido === 'egreso' ? 'sale' : 'entra'} el dinero: la empresa tiene varias`);
}

// Registra el egreso (pago_proveedor + aplicaciones) dentro de una transacción.
export async function registrarEgreso(client, { empresa_id, tercero_id, fecha, medio_pago, cuenta_pago_id, referencia, notas, aplicaciones, creado_por }) {
  const cuenta = await resolverCuentaPago(client, { empresa_id, medio_pago, cuenta_pago_id, sentido: 'egreso' });
  const total = Math.round(aplicaciones.reduce((a, x) => a + Number(x.valor), 0) * 100) / 100;
  const { rows: emp } = await client.query('update empresa set ultimo_pago = ultimo_pago + 1 where id = $1 returning ultimo_pago', [empresa_id]);
  const { rows } = await client.query(
    `insert into pago_proveedor (empresa_id, tercero_id, consecutivo, fecha, medio_pago, total, notas, creado_por, cuenta_pago_id, referencia)
     values ($1, $2, $3, coalesce($4, current_date), $5, $6, $7, $8, $9, $10) returning id, consecutivo`,
    [empresa_id, tercero_id, emp[0].ultimo_pago, fecha || null, medio_pago || 'transferencia', total, notas || null, creado_por || null, cuenta?.id || null, referencia || null]
  );
  for (const a of aplicaciones) {
    await client.query('insert into pago_proveedor_aplicacion (pago_proveedor_id, compra_id, valor) values ($1, $2, $3)', [rows[0].id, a.compra_id, Number(a.valor)]);
  }
  return { id: rows[0].id, consecutivo: rows[0].consecutivo, total, cuenta: cuenta?.nombre || null };
}
