// Conciliación bancaria automática.
//
// 1. Los gastos e ingresos financieros del extracto (4x1000, comisiones, IVA
//    de comisiones, intereses, retenciones) se contabilizan solos.
// 2. Cada movimiento del banco se cruza con los documentos ya contabilizados
//    contra la cuenta del banco (recibos de caja, ventas de contado,
//    comprobantes de egreso, nómina, aportes…): mismo valor y fecha cercana.
// 3. Lo que queda pendiente se resuelve a mano en la pantalla de conciliación.
import { pool } from '../db/pool.js';
import { contabilizarMovimientoBancario } from '../contabilidad/contabilizar.js';
import { CLASES, esFinanciero } from './extracto.js';

export const VENTANA_DIAS = 5;      // diferencia máxima de fechas para cruzar solo
const TOLERANCIA = 0.5;             // pesos

// Cuentas contables que representan esta cuenta bancaria en los libros: la
// suya y, si es el único banco de la empresa, la genérica 11100599 (pagos
// registrados por transferencia antes de crear la cuenta bancaria).
export async function cuentasDelBanco(db, cuentaPagoId) {
  const { rows } = await db.query('select * from cuenta_pago where id = $1', [cuentaPagoId]);
  const c = rows[0];
  if (!c) throw new Error('Cuenta bancaria no encontrada');
  if (c.tipo !== 'banco') throw new Error('La conciliación es para cuentas bancarias');
  const { rows: otros } = await db.query(`select count(*)::int as n from cuenta_pago where empresa_id = $1 and tipo = 'banco' and activa`, [c.empresa_id]);
  const cuentas = [c.cuenta_contable];
  if (otros[0].n <= 1 && c.cuenta_contable !== '11100599') cuentas.push('11100599');
  return { cuenta: c, cuentas };
}

// Documentos de los libros que mueven la cuenta del banco y que todavía no
// están cruzados con un movimiento del extracto.
export async function librosSinConciliar(db, { empresa_id, cuentas, desde = null, hasta = null }) {
  const { rows } = await db.query(
    `select a.origen, coalesce(a.origen_id, a.id) as origen_id, a.fecha, a.documento, a.descripcion,
            round(sum(l.debito - l.credito), 2) as valor
     from asiento a join asiento_linea l on l.asiento_id = a.id
     where a.empresa_id = $1 and l.cuenta = any($2) and a.origen <> 'movimiento_bancario'
       and ($3::date is null or a.fecha >= $3) and ($4::date is null or a.fecha <= $4)
       and not exists (select 1 from movimiento_bancario m where m.libro_origen = a.origen and m.libro_origen_id = coalesce(a.origen_id, a.id))
     group by a.origen, coalesce(a.origen_id, a.id), a.fecha, a.documento, a.descripcion
     having abs(sum(l.debito - l.credito)) > 0.005
     order by a.fecha`,
    [empresa_id, cuentas, desde, hasta]
  );
  return rows.map((r) => ({ ...r, valor: Number(r.valor) }));
}

const dias = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const ymd = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10));

// Corre la conciliación automática de una cuenta bancaria. Devuelve el resumen.
export async function conciliarCuenta(cuentaPagoId, usuario = null) {
  const client = await pool.connect();
  const resumen = { contabilizados: 0, conciliados: 0, pendientes: 0 };
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(4545)');
    const { cuenta, cuentas } = await cuentasDelBanco(client, cuentaPagoId);

    // 0. Cruces cuyo documento ya no existe en los libros (se anuló) vuelven a pendiente.
    const { rowCount: liberados } = await client.query(
      `update movimiento_bancario m set estado = 'pendiente', libro_origen = null, libro_origen_id = null, automatico = false,
              nota = coalesce(m.nota || ' · ', '') || 'El documento con que se había conciliado se anuló'
       where m.cuenta_pago_id = $1 and m.estado = 'conciliado'
         and not exists (select 1 from asiento a where a.origen = m.libro_origen and coalesce(a.origen_id, a.id) = m.libro_origen_id)`,
      [cuentaPagoId]
    );
    resumen.liberados = liberados;

    // 1. Gastos e ingresos financieros.
    const { rows: fin } = await client.query(
      `select id, clase from movimiento_bancario where cuenta_pago_id = $1 and estado = 'pendiente' and clase = any($2)`,
      [cuentaPagoId, Object.keys(CLASES)]
    );
    for (const m of fin) {
      if (!esFinanciero(m.clase)) continue;
      await client.query(
        `update movimiento_bancario set estado = 'contabilizado', contrapartida = $2, automatico = true, conciliado_en = now(), conciliado_por = $3 where id = $1`,
        [m.id, CLASES[m.clase].cuenta, usuario]
      );
      await contabilizarMovimientoBancario(client, m.id);
      resumen.contabilizados++;
    }

    // 2. Cruce con los libros: mismo valor, fecha más cercana dentro de la ventana.
    const { rows: pend } = await client.query(
      `select id, fecha, valor from movimiento_bancario where cuenta_pago_id = $1 and estado = 'pendiente' order by fecha, valor`,
      [cuentaPagoId]
    );
    const libros = await librosSinConciliar(client, { empresa_id: cuenta.empresa_id, cuentas });
    const usados = new Set();
    for (const m of pend) {
      const v = Number(m.valor);
      let mejor = null;
      for (const l of libros) {
        const k = `${l.origen}|${l.origen_id}`;
        if (usados.has(k) || Math.abs(l.valor - v) > TOLERANCIA) continue;
        const d = Math.abs(dias(ymd(m.fecha), ymd(l.fecha)));
        if (d > VENTANA_DIAS) continue;
        if (!mejor || d < mejor.d) mejor = { l, d, k };
      }
      if (!mejor) { resumen.pendientes++; continue; }
      usados.add(mejor.k);
      await client.query(
        `update movimiento_bancario set estado = 'conciliado', libro_origen = $2, libro_origen_id = $3, automatico = true, conciliado_en = now(), conciliado_por = $4 where id = $1`,
        [m.id, mejor.l.origen, mejor.l.origen_id, usuario]
      );
      resumen.conciliados++;
    }
    await client.query('commit');
    return resumen;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
