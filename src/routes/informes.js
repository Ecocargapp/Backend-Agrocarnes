// Informes: venta diaria, estado de resultados, balance general, IVA/INC a
// pagar, retenciones a pagar, libro diario. Salen de los asientos contables
// (src/contabilidad/contabilizar.js), así siempre cuadran entre sí.
// empresa_id vacío = consolidado de todas las empresas (centros de costo).
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { reconstruirContabilidad, depreciacionAlDia } from '../contabilidad/contabilizar.js';
import { auxiliar, nombreNivel, NIVELES } from '../contabilidad/puc.js';

export const router = Router();

// El usuario de punto de venta (operador) solo ve la venta diaria; el resto
// de informes contables es del administrador.
const PARA_OPERADOR = new Set(['/venta-diaria']);
router.use((req, res, next) => {
  if (req.usuario?.rol === 'admin' || (req.method === 'GET' && PARA_OPERADOR.has(req.path))) return next();
  res.status(403).json({ error: 'No tienes permiso para ver este informe' });
});

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const hoy = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); // America/Bogota

// Saldos por cuenta en un rango de fechas: { codigo: { nombre, grupo, debito, credito } }
async function saldos(empresaId, desde, hasta) {
  const params = [desde || '1900-01-01', hasta || hoy()];
  let we = '';
  if (empresaId) { params.push(empresaId); we = `and a.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select c.codigo, c.nombre, c.grupo, c.naturaleza, coalesce(sum(l.debito), 0) as debito, coalesce(sum(l.credito), 0) as credito
     from asiento_linea l join asiento a on a.id = l.asiento_id join cuenta c on c.codigo = l.cuenta
     where a.fecha between $1 and $2 ${we}
     group by c.codigo, c.nombre, c.grupo, c.naturaleza order by c.codigo`, params
  );
  return Object.fromEntries(rows.map((r) => [r.codigo, { ...r, debito: Number(r.debito), credito: Number(r.credito) }]));
}
// Saldo de una cuenta de cualquier nivel (suma sus auxiliares de 8 dígitos).
const sumaPrefijo = (s, c, campo) => Object.values(s).reduce((a, x) => a + (x.codigo.startsWith(c) ? x[campo] : 0), 0);
const deb = (s, c) => r2(sumaPrefijo(s, c, 'debito') - sumaPrefijo(s, c, 'credito')); // saldo de naturaleza débito
const cre = (s, c) => r2(sumaPrefijo(s, c, 'credito') - sumaPrefijo(s, c, 'debito')); // saldo de naturaleza crédito
const lineasGrupo = (s, grupo, fn) => Object.values(s).filter((c) => c.grupo === grupo)
  .map((c) => ({ cuenta: c.codigo, nombre: c.nombre, valor: fn(s, c.codigo) })).filter((l) => l.valor !== 0);
const suma = (ls) => r2(ls.reduce((a, l) => a + l.valor, 0));

async function prepararse() {
  try { await depreciacionAlDia(); } catch (err) { console.error('[informes] depreciación:', err.message); }
}

// ------------------------------------------------------- estado de resultados
export async function estadoResultados(empresaId, desde, hasta) {
  const s = await saldos(empresaId, desde, hasta);
  const ventasBrutas = cre(s, '4135');
  const devoluciones = deb(s, '4175');
  const ventasNetas = r2(ventasBrutas - devoluciones);
  const costo = deb(s, '6135');
  const utilidadBruta = r2(ventasNetas - costo);
  const gastosAdmin = lineasGrupo(s, 'gasto_admin', deb);
  const gastosVentas = lineasGrupo(s, 'gasto_ventas', deb);
  const totalGastosOp = r2(suma(gastosAdmin) + suma(gastosVentas));
  const ebitda = r2(utilidadBruta - totalGastosOp);
  const depreciacion = deb(s, '5160');
  const utilidadOperacional = r2(ebitda - depreciacion);
  const otrosIngresos = lineasGrupo(s, 'ingreso_no_operacional', cre);
  const gastosNoOp = lineasGrupo(s, 'gasto_no_operacional', deb);
  const uai = r2(utilidadOperacional + suma(otrosIngresos) - suma(gastosNoOp));
  const pct = (v) => (ventasNetas ? r2((v / ventasNetas) * 100) : null);

  const params = [desde || '1900-01-01', hasta || hoy()];
  let we = '';
  if (empresaId) { params.push(empresaId); we = `and empresa_id = $${params.length}`; }
  const { rows: internas } = await pool.query(
    `select coalesce(sum(total), 0) as total from factura_venta
     where venta_interna and estado <> 'anulada' and (fecha at time zone 'America/Bogota')::date between $1 and $2 ${we}`, params
  );
  return {
    desde, hasta,
    ventas_brutas: ventasBrutas, devoluciones, ventas_netas: ventasNetas,
    costo_ventas: costo, utilidad_bruta: utilidadBruta, margen_bruto_pct: pct(utilidadBruta),
    gastos_administracion: gastosAdmin, gastos_ventas: gastosVentas, total_gastos_operacionales: totalGastosOp,
    ebitda, margen_ebitda_pct: pct(ebitda),
    depreciacion, utilidad_operacional: utilidadOperacional,
    otros_ingresos: otrosIngresos, gastos_no_operacionales: gastosNoOp,
    utilidad_antes_impuestos: uai, margen_neto_pct: pct(uai),
    ventas_internas_incluidas: r2(internas[0].total),
  };
}

router.get('/estado-resultados', async (req, res) => {
  await prepararse();
  const { empresa_id, desde, hasta } = req.query;
  res.json(await estadoResultados(empresa_id || null, desde, hasta || hoy()));
});

// -------------------------------------------------------------- balance general
router.get('/balance', async (req, res) => {
  await prepararse();
  const { empresa_id } = req.query;
  const corte = req.query.corte || hoy();
  const s = await saldos(empresa_id || null, null, corte);
  const corriente = lineasGrupo(s, 'activo_corriente', deb);
  const noCorriente = lineasGrupo(s, 'activo_no_corriente', deb); // 1592 sale negativa
  const totalActivo = r2(suma(corriente) + suma(noCorriente));
  const pasivo = lineasGrupo(s, 'pasivo', cre);                   // 240802 (IVA descontable) sale negativa: resta al IVA por pagar
  const totalPasivo = suma(pasivo);
  const capital = lineasGrupo(s, 'patrimonio', cre);
  const er = await estadoResultados(empresa_id || null, null, corte);
  const resultado = er.utilidad_antes_impuestos;
  const totalPatrimonio = r2(suma(capital) + resultado);
  res.json({
    corte,
    activo_corriente: corriente, total_activo_corriente: suma(corriente),
    activo_no_corriente: noCorriente, total_activo_no_corriente: suma(noCorriente),
    total_activo: totalActivo,
    pasivo, total_pasivo: totalPasivo,
    patrimonio: [...capital, { cuenta: '3605', nombre: 'Resultado del ejercicio (antes de impuestos)', valor: resultado }],
    total_patrimonio: totalPatrimonio,
    total_pasivo_patrimonio: r2(totalPasivo + totalPatrimonio),
    diferencia: r2(totalActivo - totalPasivo - totalPatrimonio),
  });
});

// ------------------------------------------------------------------- IVA / INC
router.get('/iva', async (req, res) => {
  const { empresa_id, desde } = req.query;
  const hasta = req.query.hasta || hoy();
  const s = await saldos(empresa_id || null, desde, hasta);
  const params = [desde || '1900-01-01', hasta];
  let we = '';
  if (empresa_id) { params.push(empresa_id); we = `and f.empresa_id = $${params.length}`; }
  // Bases de venta por tarifa (facturas no anuladas; las notas crédito restan en el IVA generado).
  const { rows: bases } = await pool.query(
    `select coalesce(p.tipo_impuesto, 'IVA') as impuesto, p.impuesto_pct as tarifa,
            sum(i.cantidad * i.precio_unitario / (1 + p.impuesto_pct / 100)) as base,
            sum(i.cantidad * i.precio_unitario - i.cantidad * i.precio_unitario / (1 + p.impuesto_pct / 100)) as impuesto_valor
     from factura_venta f join factura_venta_item i on i.factura_venta_id = f.id join producto p on p.id = i.producto_id
     where f.estado <> 'anulada' and (f.fecha at time zone 'America/Bogota')::date between $1 and $2 ${we}
     group by 1, 2 order by 1, 2`, params
  );
  const ivaGenerado = cre(s, '240801');
  const ivaDescontable = deb(s, '240802');
  const reteivaNosPracticaron = deb(s, '135517');
  res.json({
    desde, hasta,
    iva: {
      generado: ivaGenerado, descontable: ivaDescontable, reteiva_que_nos_practicaron: reteivaNosPracticaron,
      saldo_a_pagar: r2(ivaGenerado - ivaDescontable - reteivaNosPracticaron),
    },
    inc: { generado: cre(s, '249595') },
    bases_por_tarifa: bases.map((b) => ({ impuesto: b.impuesto, tarifa: Number(b.tarifa), base: r2(b.base), impuesto_valor: r2(b.impuesto_valor) })),
  });
});

// ----------------------------------------------------------------- retenciones
router.get('/retenciones', async (req, res) => {
  const { empresa_id, desde } = req.query;
  const hasta = req.query.hasta || hoy();
  const params = [desde || '1900-01-01', hasta];
  let we = '';
  if (empresa_id) { params.push(empresa_id); we = `and c.empresa_id = $${params.length}`; }
  const { rows: practicadas } = await pool.query(
    `select coalesce(c.concepto_retencion, 'ninguna') as concepto, coalesce(k.nombre, 'Sin concepto') as nombre,
            count(*)::int as documentos, sum(c.subtotal) as base, sum(c.retefuente) as retefuente, sum(c.reteiva) as reteiva, sum(c.reteica) as reteica
     from compra c left join concepto_retencion k on k.codigo = c.concepto_retencion
     where c.fecha between $1 and $2 ${we} and c.estado <> 'anulado' and (c.retefuente > 0 or c.reteiva > 0 or c.reteica > 0)
     group by 1, 2 order by 1`, params
  );
  const wr = empresa_id ? `and r.empresa_id = $3` : '';
  const { rows: nos } = await pool.query(
    `select coalesce(sum(r.retefuente), 0) as retefuente, coalesce(sum(r.reteiva), 0) as reteiva, coalesce(sum(r.reteica), 0) as reteica
     from recibo_caja r where r.fecha between $1 and $2 and r.estado <> 'anulado' ${wr}`, params
  );
  // Retención por salarios (nómina), concepto aparte en el formulario 350.
  const wn = empresa_id ? `and n.empresa_id = $3` : '';
  const { rows: sal } = await pool.query(
    `select coalesce(sum((d->>'valor')::numeric), 0) as v, count(distinct n.id)::int as nominas
     from nomina n cross join lateral jsonb_array_elements(n.liquidacion->'deducciones') d
     where n.fecha_pago between $1 and $2 and n.estado <> 'anulado' and d->>'clave' = 'rete' ${wn}`, params
  );
  const tot = (k) => r2(practicadas.reduce((a, p) => a + Number(p[k]), 0));
  const aPagar = { retefuente: tot('retefuente'), reteiva: tot('reteiva'), reteica: tot('reteica'), salarios: r2(sal[0].v) };
  aPagar.total_formulario_350 = r2(aPagar.retefuente + aPagar.reteiva + aPagar.salarios);
  const nosPracticaron = { retefuente: r2(nos[0].retefuente), reteiva: r2(nos[0].reteiva), reteica: r2(nos[0].reteica) };
  res.json({
    desde, hasta,
    practicadas: practicadas.map((p) => ({ ...p, base: r2(p.base), retefuente: r2(p.retefuente), reteiva: r2(p.reteiva), reteica: r2(p.reteica) })),
    a_pagar: aPagar,
    nos_practicaron: nosPracticaron,
    resultado_neto: r2(aPagar.retefuente + aPagar.reteiva + aPagar.reteica + aPagar.salarios - nosPracticaron.retefuente - nosPracticaron.reteiva - nosPracticaron.reteica),
  });
});

// ------------------------------------------------------------------ venta diaria
router.get('/venta-diaria', async (req, res) => {
  const { empresa_id, desde } = req.query;
  const hasta = req.query.hasta || hoy();
  const params = [desde || hasta, hasta];
  let we = '';
  if (empresa_id) { params.push(empresa_id); we = `and f.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `with fv as (
       select f.id, (f.fecha at time zone 'America/Bogota')::date as dia, f.total, f.forma_pago, f.venta_interna,
              (select sum(i.cantidad * i.precio_unitario - i.cantidad * i.precio_unitario / (1 + p.impuesto_pct / 100))
                 filter (where coalesce(p.tipo_impuesto, 'IVA') = 'IVA')
               from factura_venta_item i join producto p on p.id = i.producto_id where i.factura_venta_id = f.id) as iva,
              (select sum(i.cantidad * i.precio_unitario - i.cantidad * i.precio_unitario / (1 + p.impuesto_pct / 100))
                 filter (where p.tipo_impuesto = 'INC')
               from factura_venta_item i join producto p on p.id = i.producto_id where i.factura_venta_id = f.id) as inc,
              (select r.medio_pago from recibo_caja_aplicacion a join recibo_caja r on r.id = a.recibo_caja_id
               where a.factura_venta_id = f.id order by r.creado_en limit 1) as medio
       from factura_venta f
       where f.estado <> 'anulada' and (f.fecha at time zone 'America/Bogota')::date between $1 and $2 ${we}
     )
     select dia,
            count(*) filter (where not venta_interna)::int as facturas,
            coalesce(sum(total) filter (where not venta_interna), 0) as total,
            coalesce(sum(iva) filter (where not venta_interna), 0) as iva,
            coalesce(sum(inc) filter (where not venta_interna), 0) as inc,
            coalesce(sum(total) filter (where not venta_interna and forma_pago = 'contado' and medio = 'efectivo'), 0) as efectivo,
            coalesce(sum(total) filter (where not venta_interna and forma_pago = 'contado' and medio = 'transferencia'), 0) as transferencia,
            coalesce(sum(total) filter (where not venta_interna and forma_pago = 'contado' and medio = 'tarjeta'), 0) as tarjeta,
            coalesce(sum(total) filter (where not venta_interna and forma_pago = 'contado' and coalesce(medio, 'otro') not in ('efectivo', 'transferencia', 'tarjeta')), 0) as otro,
            coalesce(sum(total) filter (where not venta_interna and forma_pago = 'credito'), 0) as credito,
            coalesce(sum(total) filter (where venta_interna), 0) as ventas_internas
     from fv group by dia order by dia`, params
  );
  const dias = rows.map((d) => {
    const o = { dia: d.dia, facturas: d.facturas };
    for (const k of ['total', 'iva', 'inc', 'efectivo', 'transferencia', 'tarjeta', 'otro', 'credito', 'ventas_internas']) o[k] = r2(d[k]);
    o.base = r2(o.total - o.iva - o.inc);
    return o;
  });
  const totales = { facturas: dias.reduce((a, d) => a + d.facturas, 0) };
  for (const k of ['total', 'base', 'iva', 'inc', 'efectivo', 'transferencia', 'tarjeta', 'otro', 'credito', 'ventas_internas']) totales[k] = r2(dias.reduce((a, d) => a + d[k], 0));
  res.json({ desde: params[0], hasta, dias, totales });
});


// ------------------------------------------------------------ balance de prueba
// Estructura: clase (1) · grupo (2) · cuenta (4) · subcuenta (6) · auxiliar (8),
// con saldo inicial, débitos, créditos y saldo final (débitos − créditos: las
// cuentas de naturaleza crédito salen negativas).
// query: empresa_id, desde, hasta, nivel (2|4|6|8, por defecto 8), cuenta (prefijo)
router.get('/balance-prueba', async (req, res) => {
  await prepararse();
  const { empresa_id } = req.query;
  const hasta = req.query.hasta || hoy();
  const desde = req.query.desde || `${hasta.slice(0, 4)}-01-01`;
  const nivelMax = [1, 2, 4, 6, 8].includes(Number(req.query.nivel)) ? Number(req.query.nivel) : 8;
  const prefijo = String(req.query.cuenta || '').replace(/\D/g, '');
  const params = [desde, hasta];
  let we = '';
  if (empresa_id) { params.push(empresa_id); we = `and a.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select l.cuenta, c.nombre,
            coalesce(sum(l.debito - l.credito) filter (where a.fecha < $1), 0) as inicial,
            coalesce(sum(l.debito) filter (where a.fecha between $1 and $2), 0) as debitos,
            coalesce(sum(l.credito) filter (where a.fecha between $1 and $2), 0) as creditos
     from asiento_linea l join asiento a on a.id = l.asiento_id join cuenta c on c.codigo = l.cuenta
     where a.fecha <= $2 ${we} group by l.cuenta, c.nombre`, params
  );
  const mapa = new Map();
  for (const r of rows) {
    const aux = auxiliar(r.cuenta);
    if (prefijo && !aux.startsWith(prefijo)) continue;
    for (const n of NIVELES) {
      if (n > nivelMax) break;
      const codigo = aux.slice(0, n);
      const x = mapa.get(codigo) || { codigo, nivel: n, nombre: nombreNivel(codigo, n === 8 ? r.nombre : null), saldo_inicial: 0, debitos: 0, creditos: 0 };
      x.saldo_inicial += Number(r.inicial); x.debitos += Number(r.debitos); x.creditos += Number(r.creditos);
      mapa.set(codigo, x);
    }
  }
  const cuentas = [...mapa.values()]
    .map((x) => ({ ...x, saldo_inicial: r2(x.saldo_inicial), debitos: r2(x.debitos), creditos: r2(x.creditos), saldo_final: r2(x.saldo_inicial + x.debitos - x.creditos) }))
    .filter((x) => x.saldo_inicial || x.debitos || x.creditos || x.saldo_final)
    .sort((a, b) => (a.codigo < b.codigo ? -1 : 1));
  const clases = cuentas.filter((x) => x.nivel === 1);
  const tot = (k) => r2(clases.reduce((a, x) => a + x[k], 0));
  res.json({
    desde, hasta, nivel: nivelMax, cuentas,
    totales: { saldo_inicial: tot('saldo_inicial'), debitos: tot('debitos'), creditos: tot('creditos'), saldo_final: tot('saldo_final') },
  });
});

// ------------------------------------------- libro auxiliar por cuenta y NIT
// "Listado de movimientos clasificado por cuenta y NIT": por cada auxiliar, sus
// terceros con saldo inicial, cada movimiento (fecha, documento, detalle,
// concepto, centro de costo, debe, haber, saldo) y el total del NIT.
// query: empresa_id, desde, hasta, cuenta (prefijo), nit
router.get('/auxiliar', async (req, res) => {
  const { empresa_id } = req.query;
  const hasta = req.query.hasta || hoy();
  const desde = req.query.desde || `${hasta.slice(0, 4)}-01-01`;
  const prefijo = String(req.query.cuenta || '').replace(/\D/g, '');
  const nitFiltro = String(req.query.nit || '').trim();
  const params = [hasta];
  let we = '';
  if (empresa_id) { params.push(empresa_id); we = `and a.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select a.fecha, a.documento, a.origen, a.descripcion as detalle, l.descripcion as concepto, e.nombre as centro_costo,
            l.cuenta, c.nombre as cuenta_nombre, l.debito, l.credito,
            coalesce(t.numero_documento, l.nit, 'SIN NIT') as nit, upper(coalesce(t.nombre, l.nit_nombre, 'SIN TERCERO')) as nit_nombre
     from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta c on c.codigo = l.cuenta
     join empresa e on e.id = a.empresa_id left join tercero t on t.id = l.tercero_id
     where a.fecha <= $1 ${we}
     order by a.fecha, a.creado_en, a.id`, params
  );
  const cuentas = new Map();
  for (const r of rows) {
    const aux = auxiliar(r.cuenta);
    if (prefijo && !aux.startsWith(prefijo)) continue;
    if (nitFiltro && !String(r.nit).includes(nitFiltro)) continue;
    if (!cuentas.has(aux)) cuentas.set(aux, { codigo: aux, nombre: nombreNivel(aux, r.cuenta === aux ? r.cuenta_nombre : null), terceros: new Map() });
    const cu = cuentas.get(aux);
    if (!cu.terceros.has(r.nit)) cu.terceros.set(r.nit, { nit: r.nit, nombre: r.nit_nombre, saldo_inicial: 0, movimientos: [], total_debe: 0, total_haber: 0 });
    const te = cu.terceros.get(r.nit);
    const fecha = r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10);
    const d = Number(r.debito); const h = Number(r.credito);
    if (fecha < desde) { te.saldo_inicial += d - h; continue; }
    te.total_debe += d; te.total_haber += h;
    te.movimientos.push({ fecha, documento: r.documento || r.origen, detalle: r.detalle, concepto: r.concepto, centro_costo: r.centro_costo, debe: r2(d), haber: r2(h) });
  }
  const salida = [...cuentas.values()].sort((a, b) => (a.codigo < b.codigo ? -1 : 1)).map((cu) => {
    const terceros = [...cu.terceros.values()]
      .filter((t) => t.movimientos.length || Math.abs(t.saldo_inicial) > 0.004)
      .sort((a, b) => String(a.nit).localeCompare(String(b.nit)))
      .map((t) => {
        let saldo = t.saldo_inicial;
        const movimientos = t.movimientos.map((m) => { saldo += m.debe - m.haber; return { ...m, saldo: r2(saldo) }; });
        return { nit: t.nit, nombre: t.nombre, saldo_inicial: r2(t.saldo_inicial), movimientos, total_debe: r2(t.total_debe), total_haber: r2(t.total_haber), saldo_final: r2(saldo) };
      });
    const s = (k) => r2(terceros.reduce((a, t) => a + t[k], 0));
    return { codigo: cu.codigo, nombre: cu.nombre, terceros, saldo_inicial: s('saldo_inicial'), total_debe: s('total_debe'), total_haber: s('total_haber'), saldo_final: s('saldo_final') };
  }).filter((c) => c.terceros.length);
  res.json({ desde, hasta, cuentas: salida });
});

// ------------------------------------------------------------------ libro diario
router.get('/libro-diario', async (req, res) => {
  const { empresa_id, desde } = req.query;
  const hasta = req.query.hasta || hoy();
  const params = [desde || '1900-01-01', hasta];
  let we = '';
  if (empresa_id) { params.push(empresa_id); we = `and a.empresa_id = $${params.length}`; }
  const { rows } = await pool.query(
    `select a.fecha, e.nombre as empresa, a.origen, a.descripcion, l.cuenta, c.nombre as cuenta_nombre,
            t.numero_documento as tercero_documento, t.nombre as tercero, l.descripcion as detalle, l.debito, l.credito
     from asiento a join asiento_linea l on l.asiento_id = a.id join cuenta c on c.codigo = l.cuenta
     join empresa e on e.id = a.empresa_id left join tercero t on t.id = l.tercero_id
     where a.fecha between $1 and $2 ${we} order by a.fecha, a.creado_en, a.id, l.debito desc`, params
  );
  res.json(rows.map((r) => ({ ...r, debito: Number(r.debito), credito: Number(r.credito) })));
});

// ---------------------------------------------------- asientos manuales (admin)
// Aporte de capital de los socios: Dr 1110/1105, Cr 3115.
router.post('/aporte-capital', requireRole('admin'), async (req, res) => {
  const { empresa_id, fecha, valor, medio, socio } = req.body || {};
  const v = r2(valor);
  if (!empresa_id || !(v > 0)) return res.status(400).json({ error: 'Indica empresa y un valor mayor que cero' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into asiento (empresa_id, fecha, origen, descripcion, creado_por) values ($1, coalesce($2, current_date), 'manual', $3, $4) returning id`,
      [empresa_id, fecha || null, `Aporte de capital${socio ? ` · ${socio}` : ''}`, req.usuario?.sub]
    );
    for (const c of ['11050501', '11100599', '31150501']) {
      await client.query(`insert into cuenta (codigo, nombre, naturaleza, grupo) values ($1, $2, $3, $4) on conflict (codigo) do nothing`,
        [c, nombreNivel(c), c.startsWith('3') ? 'credito' : 'debito', c.startsWith('3') ? 'patrimonio' : 'activo_corriente']);
    }
    await client.query(`insert into asiento_linea (asiento_id, cuenta, debito, credito, nit, nit_nombre) values ($1, $2, $3, 0, $4, $5), ($1, '31150501', 0, $3, $4, $5)`,
      [rows[0].id, medio === 'efectivo' ? '11050501' : '11100599', v, socio ? null : '0', socio ? String(socio).toUpperCase() : 'SOCIOS']);
    await client.query('commit');
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/asientos-manuales', async (req, res) => {
  const { rows } = await pool.query(
    `select a.id, a.fecha, a.descripcion, e.nombre as empresa, sum(l.debito) as valor
     from asiento a join asiento_linea l on l.asiento_id = a.id join empresa e on e.id = a.empresa_id
     where a.origen = 'manual' group by a.id, e.nombre order by a.fecha desc`
  );
  res.json(rows);
});

router.delete('/asientos-manuales/:id', requireRole('admin'), async (req, res) => {
  await pool.query(`delete from asiento where id = $1 and origen = 'manual'`, [req.params.id]);
  res.json({ ok: true });
});

// Vuelve a generar todos los asientos automáticos desde los documentos.
router.post('/reconstruir', requireRole('admin'), async (_req, res) => {
  try {
    res.json(await reconstruirContabilidad());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
