// Envía al sandbox de Factus las 20 nóminas del set de habilitación (y, con
// --ajuste, una nota de ajuste de eliminación de la primera) SIN guardar nada
// en la base de datos: solo lee la cuenta de Factus de nómina de la empresa.
//
//   node scripts/habilitacion-nomina.js "Agrocarnes"            → 20 nóminas
//   node scripts/habilitacion-nomina.js "Agrocarnes" --solo=3,5  → solo esos casos
//   node scripts/habilitacion-nomina.js "Agrocarnes" --ajuste=NEF12  → nota de ajuste (fase 2)
//   node scripts/habilitacion-nomina.js "Agrocarnes" --rango=ID  → rango de nómina si hay varios activos
//   node scripts/habilitacion-nomina.js "Agrocarnes" --solo=6 --referencia=HAB-X-06 → reenvía una pendiente con su misma referencia
//   node scripts/habilitacion-nomina.js "Agrocarnes" --ver       → muestra el JSON del caso 1 sin enviar
//
// El resultado queda en scripts/habilitacion-nomina-resultado.json.
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { liquidar } from '../src/nomina/liquidar.js';
import { armarNomina, configNomina } from '../src/dian/nomina-factus.js';
import { FactusClient, textoErrores } from '../src/dian/factus.js';
import { EMPLEADOS_PRUEBA, CASOS_PRUEBA } from '../src/nomina/casos-habilitacion.js';

const args = process.argv.slice(2);
const nombreEmpresa = args.find((a) => !a.startsWith('--')) || 'Agrocarnes';
const opcion = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? (args.includes(`--${k}`) ? true : null);

const { rows } = await pool.query('select id, nombre from empresa where nombre ilike $1', [nombreEmpresa]);
if (!rows[0]) { console.error(`No existe la empresa "${nombreEmpresa}"`); process.exit(1); }
const cfg = await configNomina(rows[0].id);
if (!cfg && !opcion('ver')) { console.error(`${rows[0].nombre} no tiene cuenta de Factus para nómina (Configuración → Nómina electrónica)`); process.exit(1); }
if (cfg && !opcion('ver') && !/sandbox/.test(cfg.base_url) && !opcion('produccion')) {
  console.error(`La cuenta de nómina apunta a ${cfg.base_url}, no al sandbox. Estas pruebas son para el sandbox (usa --produccion si de verdad quieres).`);
  process.exit(1);
}
// --rango=ID / --rango-ajuste=ID: rango a usar si la cuenta tiene varios activos.
if (cfg && opcion('rango')) cfg.numbering_range_id_nomina = opcion('rango');
if (cfg && opcion('rango-ajuste')) cfg.numbering_range_id_ajuste = opcion('rango-ajuste');
const factus = cfg ? new FactusClient(cfg) : null;
const sello = Date.now().toString(36).toUpperCase();

if (opcion('ajuste')) {
  const r = await factus.post('v2/adjustment-payrolls', { payroll_number: opcion('ajuste'), reference_code: `HAB-AJU-${sello}`, numbering_range_id: cfg.numbering_range_id_ajuste || undefined });
  console.log(JSON.stringify(r?.data, null, 2));
  process.exit(0);
}

// --limpiar: borra en Factus las nóminas que quedaron pendientes (sin validar)
// en la última corrida; una pendiente bloquea las siguientes con 409.
if (opcion('limpiar')) {
  const previos = JSON.parse(await readFile(new URL('./habilitacion-nomina-resultado.json', import.meta.url), 'utf8').catch(() => '[]'));
  for (const r of previos.filter((x) => !x.ok && x.enviado?.reference_code)) {
    try { await factus.delete(`v2/payrolls/reference/${encodeURIComponent(r.enviado.reference_code)}`); console.log(`borrada pendiente ${r.enviado.reference_code} (caso ${r.caso})`); }
    catch (err) { console.log(`no se pudo borrar ${r.enviado.reference_code}: ${err.message.slice(0, 200)}`); }
  }
  process.exit(0);
}

const solo = opcion('solo') ? String(opcion('solo')).split(',').map(Number) : null;
const resultados = [];
for (const c of CASOS_PRUEBA.filter((x) => !solo || solo.includes(x.n))) {
  const e = { tipo_documento: '13', tipo_trabajador: '01', subtipo_trabajador: '00', periodo_pago: '5', clase_riesgo_arl: 1, ...EMPLEADOS_PRUEBA[c.e] };
  const periodo = c.quincena ? '4' : '5';
  const L = liquidar({ empleado: e, anio: c.anio, mes: c.mes, periodo, quincena: c.quincena || null, novedades: c.novedades || {} });
  const n = {
    id: `${sello}-${String(c.n).padStart(2, '0')}`, referencia_envio: opcion('referencia') || `HAB-${sello}-${String(c.n).padStart(2, '0')}`, anio: c.anio, mes: c.mes,
    periodo, quincena: c.quincena || null, fecha_pago: c.pago, medio_pago: e.medio_pago, observacion: `Prueba ${c.n}: ${c.titulo}`,
    empleado_snapshot: e, liquidacion: L,
  };
  const body = armarNomina(n, cfg || {});
  if (opcion('ver')) { console.log(JSON.stringify(body, null, 2)); break; }
  process.stdout.write(`${String(c.n).padStart(2)} ${c.titulo.padEnd(70).slice(0, 70)} `);
  try {
    const r = await factus.post('v2/payrolls', body);
    const d = r?.data || {};
    const ok = Boolean(d.cune) && d.is_validated !== false;
    console.log(ok ? `✔ ${d.number}` : `✘ ${d.number || ''} ${textoErrores(d.errors) || ''}`);
    resultados.push({ caso: c.n, titulo: c.titulo, ok, numero: d.number, cune: d.cune, neto_factus: d.net_balance, neto_calculado: L.neto, errores: textoErrores(d.errors) });
  } catch (err) {
    const msg = textoErrores(err.body?.data?.errors || err.body?.errors) || err.message;
    // Un 500 puede dejar la nómina "pendiente" en Factus (bloquea las siguientes con 409):
    // se reenvía con --solo=N --referencia=<la misma> y Factus la termina de validar.
    if (err.status >= 500) console.log(`   ↳ reenviar con: --solo=${c.n} --referencia=${body.reference_code}`);
    console.log(`✘ ${msg.slice(0, 300)}`);
    resultados.push({ caso: c.n, titulo: c.titulo, ok: false, error: msg, enviado: body });
  }
}
if (!opcion('ver')) {
  await writeFile(new URL('./habilitacion-nomina-resultado.json', import.meta.url), JSON.stringify(resultados, null, 2));
  const ok = resultados.filter((r) => r.ok).length;
  console.log(`\n${ok} de ${resultados.length} aceptadas por la DIAN (sandbox). Detalle en scripts/habilitacion-nomina-resultado.json`);
}
await pool.end();
