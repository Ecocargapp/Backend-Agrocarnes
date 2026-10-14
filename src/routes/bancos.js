// Conciliación bancaria (solo administrador).
//
//   POST   /bancos/extractos                  carga un extracto (CSV o ZIP en base64) y concilia
//   GET    /bancos/extractos?cuenta_pago_id=
//   DELETE /bancos/extractos/:id              borra el extracto y lo contabilizado desde él
//   POST   /bancos/conciliar                  vuelve a correr la conciliación automática
//   GET    /bancos/conciliacion?cuenta_pago_id=&desde=&hasta=   informe de conciliación
//   GET    /bancos/movimientos/:id/sugerencias
//   POST   /bancos/movimientos/:id/conciliar  { origen, origen_id }   cruce manual con un documento
//   POST   /bancos/movimientos/:id/contabilizar { cuenta, tercero_id?, nota? }
//   POST   /bancos/movimientos/:id/deshacer
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { contabilizar } from '../contabilidad/contabilizar.js';
import { auxiliar } from '../contabilidad/puc.js';
import { textoDe, leerExtracto, conHuellas, clasificar, CLASES } from '../bancos/extracto.js';
import { conciliarCuenta, cuentasDelBanco, librosSinConciliar } from '../bancos/conciliar.js';

export const router = Router();

// Contrapartidas que se ofrecen para los movimientos sin documento.
export const CONTRAPARTIDAS = {
  ingreso: [
    { cuenta: '11050501', nombre: 'Consignación de efectivo de la caja' },
    { cuenta: '28050501', nombre: 'Ingreso por identificar (anticipo de cliente)' },
    { cuenta: '13050501', nombre: 'Abono de cliente (cartera)', tercero: true },
    { cuenta: '31150501', nombre: 'Aporte de capital de socios', tercero: true },
    { cuenta: '23809501', nombre: 'Préstamo recibido (acreedores varios)', tercero: true },
    { cuenta: '42100501', nombre: 'Intereses / rendimientos financieros' },
    { cuenta: '42959501', nombre: 'Otros ingresos' },
  ],
  egreso: [
    { cuenta: '11050501', nombre: 'Retiro para la caja' },
    { cuenta: '22050501', nombre: 'Pago a proveedor (sin factura en el sistema)', tercero: true },
    { cuenta: '13300501', nombre: 'Anticipo a proveedor', tercero: true },
    { cuenta: '13301501', nombre: 'Anticipo a trabajador', tercero: true },
    { cuenta: '53050501', nombre: 'Gastos bancarios' },
    { cuenta: '51159501', nombre: 'Gravamen 4x1000' },
    { cuenta: '53959501', nombre: 'Otros gastos' },
  ],
};

const ymd = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : (v ? String(v).slice(0, 10) : null));

// ------------------------------------------------------------------ extractos
router.post('/extractos', async (req, res) => {
  const { cuenta_pago_id, archivo, contenido_base64, saldo_final } = req.body || {};
  if (!cuenta_pago_id || !contenido_base64) return res.status(400).json({ error: 'Elige la cuenta bancaria y el archivo del extracto' });
  let leido;
  try {
    leido = leerExtracto(textoDe(Buffer.from(String(contenido_base64), 'base64')));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const movs = conHuellas(leido.movimientos);
  const client = await pool.connect();
  let extractoId;
  try {
    await client.query('begin');
    const { cuenta } = await cuentasDelBanco(client, cuenta_pago_id);
    if (cuenta.numero && leido.cuenta_banco) {
      const solo = (s) => String(s).replace(/\D/g, '').replace(/^0+/, '');
      if (solo(cuenta.numero) && solo(leido.cuenta_banco) && !solo(leido.cuenta_banco).endsWith(solo(cuenta.numero)) && !solo(cuenta.numero).endsWith(solo(leido.cuenta_banco))) {
        throw new Error(`El extracto es de la cuenta ${leido.cuenta_banco} y elegiste ${cuenta.nombre} (${cuenta.numero})`);
      }
    }
    const fechas = movs.map((m) => m.fecha).sort();
    const { rows } = await client.query(
      `insert into extracto_bancario (empresa_id, cuenta_pago_id, archivo, cuenta_banco, desde, hasta, saldo_final, movimientos, creado_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [cuenta.empresa_id, cuenta.id, archivo || null, leido.cuenta_banco, fechas[0], fechas[fechas.length - 1],
        saldo_final === '' || saldo_final == null ? null : Number(saldo_final), movs.length, req.usuario?.sub || null]
    );
    extractoId = rows[0].id;
    let nuevos = 0;
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
    const resumen = await conciliarCuenta(cuenta.id, req.usuario?.sub || null);
    res.status(201).json({ id: extractoId, formato: leido.formato, cuenta_banco: leido.cuenta_banco, desde: fechas[0], hasta: fechas[fechas.length - 1], movimientos: movs.length, nuevos, repetidos: movs.length - nuevos, ...resumen });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/extractos', async (req, res) => {
  const { rows } = await pool.query(
    `select x.*, c.nombre as cuenta, (select count(*)::int from movimiento_bancario m where m.extracto_id = x.id and m.estado = 'pendiente') as pendientes
     from extracto_bancario x join cuenta_pago c on c.id = x.cuenta_pago_id
     where ($1::uuid is null or x.cuenta_pago_id = $1) order by x.creado_en desc limit 100`,
    [req.query.cuenta_pago_id || null]
  );
  res.json(rows);
});

router.delete('/extractos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `delete from asiento where origen = 'movimiento_bancario' and origen_id in (select id from movimiento_bancario where extracto_id = $1)`, [req.params.id]
    );
    const { rowCount } = await client.query('delete from extracto_bancario where id = $1', [req.params.id]);
    if (!rowCount) throw new Error('Extracto no encontrado');
    await client.query('commit');
    res.json({ ok: true });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/conciliar', async (req, res) => {
  try {
    res.json(await conciliarCuenta(req.body?.cuenta_pago_id, req.usuario?.sub || null));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------------ informe
router.get('/conciliacion', async (req, res) => {
  try {
    const { cuenta_pago_id } = req.query;
    const { cuenta, cuentas } = await cuentasDelBanco(pool, cuenta_pago_id);
    const { rows: rango } = await pool.query('select min(fecha) as d, max(fecha) as h from movimiento_bancario where cuenta_pago_id = $1', [cuenta.id]);
    const desde = req.query.desde || ymd(rango[0].d) || ymd(new Date());
    const hasta = req.query.hasta || ymd(rango[0].h) || ymd(new Date());

    const { rows: movs } = await pool.query(
      `select m.id, m.fecha, m.valor, m.codigo, m.descripcion, m.clase, m.estado, m.automatico, m.nota, m.contrapartida,
              m.libro_origen, m.libro_origen_id, cu.nombre as contrapartida_nombre,
              (select a.documento from asiento a where a.origen = m.libro_origen and coalesce(a.origen_id, a.id) = m.libro_origen_id limit 1) as libro_documento,
              (select a.descripcion from asiento a where a.origen = m.libro_origen and coalesce(a.origen_id, a.id) = m.libro_origen_id limit 1) as libro_descripcion
       from movimiento_bancario m left join cuenta cu on cu.codigo = m.contrapartida
       where m.cuenta_pago_id = $1 and m.fecha between $2 and $3
       order by m.fecha, m.creado_en, m.valor desc`,
      [cuenta.id, desde, hasta]
    );
    const libros = await librosSinConciliar(pool, { empresa_id: cuenta.empresa_id, cuentas, desde, hasta });
    const { rows: saldos } = await pool.query(
      `select coalesce(sum(l.debito - l.credito) filter (where a.fecha < $3), 0) as inicial,
              coalesce(sum(l.debito - l.credito) filter (where a.fecha <= $4), 0) as final
       from asiento a join asiento_linea l on l.asiento_id = a.id where a.empresa_id = $1 and l.cuenta = any($2)`,
      [cuenta.empresa_id, cuentas, desde, hasta]
    );
    const { rows: ext } = await pool.query(
      `select saldo_final, hasta from extracto_bancario where cuenta_pago_id = $1 and saldo_final is not null and hasta <= $2 order by hasta desc, creado_en desc limit 1`,
      [cuenta.id, hasta]
    );
    const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
    const suma = (arr, f) => r2(arr.filter(f).reduce((a, x) => a + Number(x.valor), 0));
    const pendBanco = movs.filter((m) => m.estado === 'pendiente');
    const pendientesBanco = suma(pendBanco, () => true);
    const pendientesLibros = suma(libros, () => true);
    const saldoLibros = r2(saldos[0].final);
    const saldoExtractoCalculado = r2(saldoLibros + pendientesBanco - pendientesLibros);
    const saldoExtracto = ext[0] && ymd(ext[0].hasta) === hasta ? r2(ext[0].saldo_final) : null;
    res.json({
      cuenta: { id: cuenta.id, nombre: cuenta.nombre, numero: cuenta.numero, cuenta_contable: cuenta.cuenta_contable, empresa_id: cuenta.empresa_id },
      desde, hasta,
      resumen: {
        movimientos: movs.length,
        conciliados: movs.filter((m) => m.estado === 'conciliado').length,
        contabilizados: movs.filter((m) => m.estado === 'contabilizado').length,
        pendientes: pendBanco.length,
        ingresos_banco: suma(movs, (m) => Number(m.valor) > 0),
        egresos_banco: suma(movs, (m) => Number(m.valor) < 0),
        gastos_financieros: suma(movs, (m) => m.estado === 'contabilizado' && m.automatico && Number(m.valor) < 0),
        ingresos_financieros: suma(movs, (m) => m.estado === 'contabilizado' && m.automatico && Number(m.valor) > 0),
        saldo_libros_inicial: r2(saldos[0].inicial),
        saldo_libros: saldoLibros,
        pendientes_banco: pendientesBanco,
        pendientes_libros: pendientesLibros,
        saldo_extracto_calculado: saldoExtractoCalculado,
        saldo_extracto: saldoExtracto,
        diferencia: saldoExtracto == null ? null : r2(saldoExtracto - saldoExtractoCalculado),
      },
      movimientos: movs.map((m) => ({ ...m, valor: Number(m.valor), fecha: ymd(m.fecha), clase_nombre: CLASES[m.clase]?.nombre || null })),
      libros_pendientes: libros.map((l) => ({ ...l, fecha: ymd(l.fecha) })),
      contrapartidas: CONTRAPARTIDAS,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------------ movimientos
async function cargarMov(db, id) {
  const { rows } = await db.query('select * from movimiento_bancario where id = $1', [id]);
  if (!rows[0]) throw new Error('Movimiento no encontrado');
  return rows[0];
}

router.get('/movimientos/:id/sugerencias', async (req, res) => {
  try {
    const m = await cargarMov(pool, req.params.id);
    const { cuentas } = await cuentasDelBanco(pool, m.cuenta_pago_id);
    const v = Number(m.valor);
    const f = ymd(m.fecha);
    const libros = (await librosSinConciliar(pool, { empresa_id: m.empresa_id, cuentas }))
      .filter((l) => Math.sign(l.valor) === Math.sign(v))
      .map((l) => ({ ...l, fecha: ymd(l.fecha), diferencia: Math.round((l.valor - v) * 100) / 100, dias: Math.round((new Date(ymd(l.fecha)) - new Date(f)) / 86400000) }))
      .sort((a, b) => Math.abs(a.diferencia) - Math.abs(b.diferencia) || Math.abs(a.dias) - Math.abs(b.dias))
      .slice(0, 15);
    let documentos = [];
    if (v > 0) {
      const { rows } = await pool.query(
        `select f.id, f.consecutivo as numero, f.fecha, f.saldo, f.total, f.cliente_id as tercero_id, coalesce(t.nombre, 'Consumidor final') as tercero
         from factura_venta f left join tercero t on t.id = f.cliente_id
         where f.empresa_id = $1 and f.estado = 'vigente' and f.saldo > 0 and not coalesce(f.venta_interna, false)
         order by abs(f.saldo - $2), f.fecha desc limit 15`, [m.empresa_id, v]
      );
      documentos = rows.map((r) => ({ ...r, tipo: 'factura', saldo: Number(r.saldo) }));
    } else {
      const { rows } = await pool.query(
        `select c.id, coalesce(c.numero_factura_proveedor, c.descripcion) as numero, c.fecha, c.saldo, c.total, c.proveedor_id as tercero_id, t.nombre as tercero, c.clase
         from compra c join tercero t on t.id = c.proveedor_id
         where c.empresa_id = $1 and c.estado = 'vigente' and c.saldo > 0
         order by abs(c.saldo - $2), c.fecha desc limit 15`, [m.empresa_id, -v]
      );
      documentos = rows.map((r) => ({ ...r, tipo: 'compra', saldo: Number(r.saldo) }));
    }
    res.json({ movimiento: { ...m, valor: v, fecha: f }, libros, documentos, contrapartidas: v > 0 ? CONTRAPARTIDAS.ingreso : CONTRAPARTIDAS.egreso });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/movimientos/:id/conciliar', async (req, res) => {
  const { origen, origen_id } = req.body || {};
  try {
    const m = await cargarMov(pool, req.params.id);
    if (m.estado !== 'pendiente') throw new Error('El movimiento ya está conciliado');
    const { cuentas } = await cuentasDelBanco(pool, m.cuenta_pago_id);
    const libro = (await librosSinConciliar(pool, { empresa_id: m.empresa_id, cuentas })).find((l) => l.origen === origen && l.origen_id === origen_id);
    if (!libro) throw new Error('Ese documento no mueve esta cuenta bancaria o ya está conciliado');
    if (Math.sign(libro.valor) !== Math.sign(Number(m.valor))) throw new Error('El documento va en sentido contrario al movimiento del banco');
    await pool.query(
      `update movimiento_bancario set estado = 'conciliado', libro_origen = $2, libro_origen_id = $3, automatico = false, conciliado_en = now(), conciliado_por = $4,
              nota = $5 where id = $1`,
      [m.id, origen, origen_id, req.usuario?.sub || null,
        Math.abs(libro.valor - Number(m.valor)) > 0.5 ? `Diferencia de ${Math.round((Number(m.valor) - libro.valor) * 100) / 100} con ${libro.documento || origen}` : null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/movimientos/:id/contabilizar', async (req, res) => {
  const { cuenta, tercero_id, nota } = req.body || {};
  try {
    const m = await cargarMov(pool, req.params.id);
    if (m.estado !== 'pendiente') throw new Error('El movimiento ya está conciliado');
    if (!cuenta) throw new Error('Elige la contrapartida');
    const aux = auxiliar(cuenta);
    const { cuenta: banco } = await cuentasDelBanco(pool, m.cuenta_pago_id);
    if (aux === banco.cuenta_contable) throw new Error('La contrapartida no puede ser la misma cuenta del banco');
    await pool.query(
      `update movimiento_bancario set estado = 'contabilizado', contrapartida = $2, contrapartida_tercero_id = $3, nota = $4, automatico = false,
              conciliado_en = now(), conciliado_por = $5 where id = $1`,
      [m.id, aux, tercero_id || null, nota || null, req.usuario?.sub || null]
    );
    await contabilizar('movimiento_bancario', m.id);
    const { rows } = await pool.query(`select 1 from asiento where origen = 'movimiento_bancario' and origen_id = $1`, [m.id]);
    if (!rows.length) {
      await pool.query(`update movimiento_bancario set estado = 'pendiente', contrapartida = null, contrapartida_tercero_id = null where id = $1`, [m.id]);
      throw new Error('No se pudo contabilizar el movimiento');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/movimientos/:id/deshacer', async (req, res) => {
  try {
    const m = await cargarMov(pool, req.params.id);
    await pool.query(`delete from asiento where origen = 'movimiento_bancario' and origen_id = $1`, [m.id]);
    await pool.query(
      `update movimiento_bancario set estado = 'pendiente', libro_origen = null, libro_origen_id = null, contrapartida = null,
              contrapartida_tercero_id = null, automatico = false, nota = null, conciliado_en = null, conciliado_por = null where id = $1`, [m.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
