// Importa un extracto bancario (CSV o ZIP) a una cuenta y corre la conciliación.
// Lo usan la ruta POST /bancos/extractos y scripts/importar-extracto.js.
import { pool } from '../db/pool.js';
import { textoDe, leerExtracto, conHuellas, clasificar } from './extracto.js';
import { conciliarCuenta, cuentasDelBanco } from './conciliar.js';

export async function importarExtracto({ cuenta_pago_id, archivo = null, buffer, saldo_final = null, usuario = null }) {
  const leido = leerExtracto(textoDe(buffer));
  const movs = conHuellas(leido.movimientos);
  const client = await pool.connect();
  let extractoId; let nuevos = 0; let cuentaId;
  const fechas = movs.map((m) => m.fecha).sort();
  try {
    await client.query('begin');
    const { cuenta } = await cuentasDelBanco(client, cuenta_pago_id);
    cuentaId = cuenta.id;
    if (cuenta.numero && leido.cuenta_banco) {
      const solo = (s) => String(s).replace(/\D/g, '').replace(/^0+/, '');
      const a = solo(cuenta.numero); const b = solo(leido.cuenta_banco);
      if (a && b && !b.endsWith(a) && !a.endsWith(b)) {
        throw new Error(`El extracto es de la cuenta ${leido.cuenta_banco} y elegiste ${cuenta.nombre} (${cuenta.numero})`);
      }
    }
    const { rows } = await client.query(
      `insert into extracto_bancario (empresa_id, cuenta_pago_id, archivo, cuenta_banco, desde, hasta, saldo_final, movimientos, creado_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [cuenta.empresa_id, cuenta.id, archivo, leido.cuenta_banco, fechas[0], fechas[fechas.length - 1],
        saldo_final === '' || saldo_final == null ? null : Number(saldo_final), movs.length, usuario]
    );
    extractoId = rows[0].id;
    for (const m of movs) {
      const r = await client.query(
        `insert into movimiento_bancario (extracto_id, empresa_id, cuenta_pago_id, fecha, valor, codigo, descripcion, huella, clase)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (cuenta_pago_id, huella) do nothing`,
        [extractoId, cuenta.empresa_id, cuenta.id, m.fecha, m.valor, m.codigo, m.descripcion, m.huella, clasificar(m)]
      );
      nuevos += r.rowCount;
    }
    await client.query('update extracto_bancario set nuevos = $2 where id = $1', [extractoId, nuevos]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const resumen = await conciliarCuenta(cuentaId, usuario);
  return {
    id: extractoId, formato: leido.formato, cuenta_banco: leido.cuenta_banco, desde: fechas[0], hasta: fechas[fechas.length - 1],
    movimientos: movs.length, nuevos, repetidos: movs.length - nuevos, ...resumen,
  };
}
