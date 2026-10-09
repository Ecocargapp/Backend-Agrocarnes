// Cajas, cuentas bancarias y tarjetas de crédito por empresa.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { MEDIOS_PAGO, siguienteCuentaContable } from '../contabilidad/cuentas-pago.js';

export const router = Router();

router.get('/', async (req, res) => {
  const { empresa_id, todas } = req.query;
  const params = []; const w = [];
  if (empresa_id) { params.push(empresa_id); w.push(`c.empresa_id = $${params.length}`); }
  if (!todas) w.push('c.activa');
  const { rows } = await pool.query(
    `select c.*, e.nombre as empresa,
            coalesce((select sum(l.debito - l.credito) from asiento_linea l join asiento a on a.id = l.asiento_id
                      where l.cuenta = c.cuenta_contable and a.empresa_id = c.empresa_id), 0) as saldo
     from cuenta_pago c join empresa e on e.id = c.empresa_id
     ${w.length ? `where ${w.join(' and ')}` : ''} order by e.nombre, case c.tipo when 'caja' then 0 when 'banco' then 1 else 2 end, c.nombre`, params
  );
  res.json(rows.map((r) => ({ ...r, saldo: r.tipo === 'tarjeta_credito' ? -Number(r.saldo) : Number(r.saldo) })));
});

router.get('/medios', (_req, res) => {
  res.json(Object.entries(MEDIOS_PAGO).filter(([k]) => k !== 'tarjeta').map(([id, m]) => ({ id, ...m })));
});

// body: { empresa_id, tipo: caja|banco|tarjeta_credito, nombre, banco, tipo_cuenta, numero }
router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.empresa_id || !['caja', 'banco', 'tarjeta_credito'].includes(b.tipo)) return res.status(400).json({ error: 'Indica empresa y tipo (caja, banco o tarjeta de crédito)' });
  const nombre = (b.nombre || '').trim() || [b.banco, b.tipo_cuenta, b.numero ? `···${String(b.numero).slice(-4)}` : ''].filter(Boolean).join(' ');
  if (!nombre) return res.status(400).json({ error: 'Ponle un nombre (ej. Bancolombia ahorros ···4321)' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(4343)');
    let cuenta = '11050501';
    if (b.tipo === 'caja') {
      // Cajas: auxiliares de la 110505; la caja general es 11050501 y las adicionales 11050502…
      const { rows } = await client.query(`select count(*)::int as n from cuenta_pago where tipo = 'caja' and empresa_id = $1`, [b.empresa_id]);
      if (rows[0].n > 0) {
        const { rows: m } = await client.query(`select coalesce(max(substring(codigo from 7)::int), 0) + 1 as n from cuenta where codigo ~ '^110505\\d{2}$'`);
        cuenta = `110505${String(m[0].n).padStart(2, '0')}`;
      }
    } else {
      cuenta = await siguienteCuentaContable(client, b.tipo);
    }
    const { rows: emp } = await client.query('select nombre from empresa where id = $1', [b.empresa_id]);
    if (!emp[0]) throw new Error('Empresa no encontrada');
    await client.query(
      `insert into cuenta (codigo, nombre, naturaleza, grupo) values ($1, $2, $3, $4) on conflict (codigo) do nothing`,
      [cuenta, `${nombre} (${emp[0].nombre})`, b.tipo === 'tarjeta_credito' ? 'credito' : 'debito', b.tipo === 'tarjeta_credito' ? 'pasivo' : 'activo_corriente']
    );
    const { rows } = await client.query(
      `insert into cuenta_pago (empresa_id, tipo, nombre, banco, tipo_cuenta, numero, cuenta_contable) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [b.empresa_id, b.tipo, nombre, b.banco || null, b.tipo_cuenta || null, b.numero || null, cuenta]
    );
    await client.query('commit');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('rollback');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { nombre, activa } = req.body || {};
  const { rows } = await pool.query(
    `update cuenta_pago set nombre = coalesce(nullif(trim($2), ''), nombre), activa = coalesce($3, activa) where id = $1 returning *`,
    [req.params.id, nombre ?? null, typeof activa === 'boolean' ? activa : null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json(rows[0]);
});
