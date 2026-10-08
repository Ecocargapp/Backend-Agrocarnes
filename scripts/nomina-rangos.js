// Rangos de numeración de nómina en Factus (la cuenta de nómina de la empresa).
//
//   node scripts/nomina-rangos.js "Agrocarnes"                          → muestra ambiente y rangos
//   node scripts/nomina-rangos.js "Agrocarnes" --crear=CODIGO --prefijo=NE --actual=1
//   node scripts/nomina-rangos.js "Agrocarnes" --usar-nomina=ID --usar-ajuste=ID  → guarda los ids en la configuración
import { pool } from '../src/db/pool.js';
import { configNomina, probarConexionNomina, crearRangoNomina } from '../src/dian/nomina-factus.js';

const args = process.argv.slice(2);
const nombre = args.find((a) => !a.startsWith('--')) || 'Agrocarnes';
const op = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

const { rows } = await pool.query('select id, nombre, nomina_config from empresa where nombre ilike $1', [nombre]);
if (!rows[0]) { console.error(`No existe la empresa "${nombre}"`); process.exit(1); }
const cfg = await configNomina(rows[0].id);
if (!cfg) { console.error('La empresa no tiene cuenta de Factus para nómina'); process.exit(1); }
console.log(`Ambiente: ${cfg.base_url} · usuario ${cfg.email} · cuenta de ${cfg.empresa_cuenta}`);
console.log(`Configurado: nómina=${cfg.numbering_range_id_nomina || '-'} ajuste=${cfg.numbering_range_id_ajuste || '-'}`);

try {
  if (op('crear')) {
    const r = await crearRangoNomina(cfg, { documento: op('crear'), prefijo: op('prefijo') || 'NE', actual: op('actual') || 1 });
    console.log('Creado:', JSON.stringify(r));
  }
  if (op('usar-nomina') || op('usar-ajuste')) {
    const nc = { ...(rows[0].nomina_config || {}) };
    if (op('usar-nomina')) nc.numbering_range_id_nomina = op('usar-nomina');
    if (op('usar-ajuste')) nc.numbering_range_id_ajuste = op('usar-ajuste');
    await pool.query('update empresa set nomina_config = $1 where id = $2', [nc, rows[0].id]);
    console.log('Rangos guardados en la configuración de', rows[0].nombre);
  }
  const { rangos } = await probarConexionNomina(cfg);
  console.log('Rangos en Factus:');
  for (const r of rangos) console.log(`  ${r.id}  ${r.documento} (${r.codigo_documento})  prefijo ${r.prefijo}  siguiente ${r.actual}  ${r.activo ? 'activo' : 'inactivo'}`);
  if (!rangos.length) console.log('  (ninguno)');
} catch (err) {
  console.error('Error:', err.message);
  if (err.body) console.error(JSON.stringify(err.body).slice(0, 1500));
}
await pool.end();
