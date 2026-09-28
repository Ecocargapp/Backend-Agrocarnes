import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

// Corre cada .sql de /migrations en orden, una sola vez cada uno: lleva el
// registro en la tabla schema_migrations, así `npm run migrate` se puede
// ejecutar en cada despliegue sin volver a aplicar lo que ya está.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../migrations');

async function run() {
  await pool.query(`
    create table if not exists schema_migrations (
      nombre text primary key,
      aplicada_en timestamptz not null default now()
    )
  `);
  const { rows } = await pool.query('select nombre from schema_migrations');
  const aplicadas = new Set(rows.map((r) => r.nombre));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let nuevas = 0;
  for (const file of files) {
    if (aplicadas.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`Aplicando ${file}...`);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (nombre) values ($1)', [file]);
      await client.query('commit');
      console.log(`OK: ${file}`);
      nuevas++;
    } catch (err) {
      await client.query('rollback');
      console.error(`Error en ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(nuevas === 0 ? 'Sin migraciones pendientes.' : `${nuevas} migración(es) aplicada(s).`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
