import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool.js';

// Crea el usuario admin, o si ya existe le actualiza la contraseña. Uso:
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
   on conflict (email) do update
     set password_hash = excluded.password_hash, rol = 'admin', activo = true
   returning id, email, (xmax = 0) as creado`,
  [nombre || email, email, hash]
);
console.log(rows[0].creado ? 'Usuario creado:' : 'Contraseña actualizada:', rows[0].email);
await pool.end();
