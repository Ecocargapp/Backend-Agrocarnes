import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

// Corre cada .sql de /migrations, en orden, dentro de una transacción cada uno.
// No lleva control de "ya aplicadas" todavía — para un solo desarrollador y
// un servidor, alcanza con no volver a correr una migración ya aplicada.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../migrations');

async function run() {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`Aplicando ${file}...`);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('commit');
      console.log(`OK: ${file}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`Error en ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
