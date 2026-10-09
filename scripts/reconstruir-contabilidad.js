// Borra y vuelve a generar todos los asientos automáticos desde los documentos
// (igual que el botón "Reconstruir contabilidad" de Informes).
import { pool } from '../src/db/pool.js';
import { reconstruirContabilidad } from '../src/contabilidad/contabilizar.js';
try { console.log(JSON.stringify(await reconstruirContabilidad())); } catch (err) { console.error(err.message); }
await pool.end();
