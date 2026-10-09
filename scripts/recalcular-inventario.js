// Recalcula existencias (cantidad y costo promedio) reproduciendo los movimientos.
//   node scripts/recalcular-inventario.js            → muestra qué cambiaría
//   node scripts/recalcular-inventario.js --aplicar  → aplica los cambios
import { pool } from '../src/db/pool.js';
import { recalcularExistencias } from '../src/db/inventario.js';
const aplicar = process.argv.includes('--aplicar');
const client = await pool.connect();
const valor = async () => (await client.query(`select e.nombre, round(sum(x.cantidad*x.costo_promedio)) v from existencia x join bodega b on b.id=x.bodega_id join empresa e on e.id=b.empresa_id group by 1 order by 1`)).rows;
try {
  await client.query('begin');
  console.log('Valor antes:', JSON.stringify(await valor()));
  const cambios = await recalcularExistencias(client, { aplicar });
  const { rows: nombres } = await client.query('select id, nombre from producto');
  const n = Object.fromEntries(nombres.map((p) => [p.id, p.nombre]));
  for (const c of cambios) console.log(`${n[c.producto_id]}: ${c.antes.cantidad} @ ${c.antes.costo.toFixed(2)} → ${c.despues.cantidad} @ ${c.despues.costo.toFixed(2)}`);
  if (aplicar) console.log('Valor después:', JSON.stringify(await valor()));
  await client.query(aplicar ? 'commit' : 'rollback');
  console.log(`${cambios.length} existencias ${aplicar ? 'corregidas' : 'por corregir (usa --aplicar)'}`);
} catch (err) { await client.query('rollback'); console.error(err.message); }
client.release(); await pool.end();
