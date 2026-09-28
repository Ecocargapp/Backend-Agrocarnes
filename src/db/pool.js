import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// Pool propio de Agrocarnes: apunta a PGDATABASE=agrocarnes, una base de
// datos separada de la que usa AgroSoft en el mismo servidor Postgres.
export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

export async function query(text, params) {
  return pool.query(text, params);
}

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres (agrocarnes-api):', err);
});
