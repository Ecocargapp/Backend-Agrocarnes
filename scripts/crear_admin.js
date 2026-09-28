import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

// Crea el primer usuario admin. Uso:
//   node scripts/crear_admin.js jonatan@agrocarnes.com "una-clave-segura" "Jonatan"
const [, , email, password, nombre] = process.argv;
if (!email || !password) {
  console.error('Uso: node scripts/crear_admin.js <email> <password> [nombre]');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 10);
const { rows } = await pool.query(
  `insert into usuario (nombre, email, password_hash, rol)
   values ($1, $2, $3, 'admin')
   returning id, email`,
  [nombre || email, email, hash]
);
console.log('Usuario creado:', rows[0]);
await pool.end();
