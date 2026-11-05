// Corrige una nota crédito que quedó guardada con el número y el CUFE de la
// factura referenciada (bug del 2026-11-05: se leía data.bill de la respuesta).
// Uso: node scripts/reparar-nota-factus.js NC1
// Consulta la nota en Factus, verifica que su reference_code sea AGC-NC-<id>
// de una nota local y guarda su número y su CUDE.
import { pool } from '../src/db/pool.js';
import { FactusClient } from '../src/dian/factus.js';

const numero = process.argv[2];
if (!numero) { console.error('Uso: node scripts/reparar-nota-factus.js <número Factus, ej. NC1>'); process.exit(1); }
const { rows: emp } = await pool.query(`select factus_config from empresa where factus_config ? 'client_id' limit 1`);
const factus = new FactusClient(emp[0].factus_config);
const d = (await factus.get(`v2/credit-notes/${encodeURIComponent(numero)}`))?.data || {};
const id = String(d.reference_code || '').replace(/^AGC-NC-/, '');
if (!d.number || !d.cude || !id) { console.error('Factus no devolvió número, CUDE o referencia:', d.number, d.cude, d.reference_code); process.exit(1); }
const { rows } = await pool.query(
  `update nota_credito set consecutivo = $2, cufe = $3, estado_dian = 'aceptada' where id = $1 returning id, consecutivo, left(cufe, 20) as cude`,
  [id, d.number, d.cude]
);
console.log(rows[0] ? `Nota corregida: ${JSON.stringify(rows[0])}` : `No hay nota local con id ${id}`);
await pool.end();
