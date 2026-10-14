// Carga un extracto bancario desde la consola y concilia.
//   node scripts/importar-extracto.js <archivo.csv|.zip> [--cuenta=<numero o id de la cuenta bancaria>] [--saldo=<saldo final>]
// Sin --cuenta, busca la cuenta bancaria cuyo número coincide con el del extracto.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/pool.js';
import { textoDe, leerExtracto } from '../src/bancos/extracto.js';
import { importarExtracto } from '../src/bancos/importar.js';

const args = process.argv.slice(2);
const opcion = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const archivo = args.find((a) => !a.startsWith('--'));
if (!archivo) { console.error('Uso: node scripts/importar-extracto.js <archivo.csv|.zip> [--cuenta=numero] [--saldo=valor]'); process.exit(1); }
const buffer = fs.readFileSync(archivo);
const leido = leerExtracto(textoDe(buffer));
const solo = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
const buscado = solo(opcion('cuenta') || leido.cuenta_banco);
const { rows } = await pool.query(`select id, nombre, numero from cuenta_pago where tipo = 'banco' and activa`);
const cuenta = rows.find((c) => c.id === opcion('cuenta')) || rows.find((c) => solo(c.numero) && (solo(c.numero).endsWith(buscado) || buscado.endsWith(solo(c.numero))));
if (!cuenta) { console.error(`No hay una cuenta bancaria con el número ${leido.cuenta_banco || opcion('cuenta')}`); process.exit(1); }
console.log(`Cuenta: ${cuenta.nombre} (${cuenta.numero})`);
const r = await importarExtracto({ cuenta_pago_id: cuenta.id, archivo: path.basename(archivo), buffer, saldo_final: opcion('saldo') ?? null });
console.log(JSON.stringify(r, null, 2));
await pool.end();
