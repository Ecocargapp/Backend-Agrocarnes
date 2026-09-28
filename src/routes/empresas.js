import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { configPublica } from '../dian/arco.js';
import { probarConexion } from '../dian/cliente.js';

export const router = Router();

router.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `select id, nombre, nit, es_facturador_dian, prefijo_factura,
            (arco_config is not null and arco_config->>'host' is not null) as arco_configurada
     from empresa order by nombre`
  );
  res.json(rows);
});

// Configuración de Arco (solo admin). La contraseña nunca se devuelve.
router.get('/:id/arco', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select nombre, arco_config from empresa where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ empresa: rows[0].nombre, config: configPublica(rows[0].arco_config) });
});

router.put('/:id/arco', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select arco_config from empresa where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  const anterior = rows[0].arco_config || {};
  const b = req.body || {};
  const config = {
    host: (b.host || '').trim(),
    company: (b.company || '').trim(),
    user: (b.user || '').trim(),
    password: b.password ? String(b.password) : anterior.password, // si viene vacía, se conserva
    documento_id: b.documento_id ? Number(b.documento_id) : null,
    resolucion_tipo: (b.resolucion_tipo || '04').trim(),
    sucursal_id: String(b.sucursal_id || '').trim(),
    bodega_id: String(b.bodega_id || '').trim(),
    cliente_default_id: String(b.cliente_default_id || '').trim(),
    vendedor_id: String(b.vendedor_id || '0').trim(),
    tipo_pago: (b.tipo_pago || 'E').trim(),
    ciudad_id: String(b.ciudad_id || '05001').trim(),
    precios_incluyen_impuesto: b.precios_incluyen_impuesto !== false,
  };
  if (!config.host || !config.company || !config.user || !config.password) {
    return res.status(400).json({ error: 'host, company, user y password son obligatorios' });
  }
  await pool.query('update empresa set arco_config = $1, es_facturador_dian = true where id = $2', [config, req.params.id]);
  res.json({ ok: true, config: configPublica(config) });
});

router.delete('/:id/arco', requireRole('admin'), async (req, res) => {
  await pool.query('update empresa set arco_config = null where id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Prueba credenciales (las del body, o las guardadas si no se envía password) y
// devuelve sucursales, bodegas y documentos en uso para poder configurar.
router.post('/:id/arco/probar', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select arco_config from empresa where id = $1', [req.params.id]);
  const guardada = rows[0]?.arco_config || {};
  const b = req.body || {};
  const cfg = {
    host: b.host || guardada.host,
    company: b.company || guardada.company,
    user: b.user || guardada.user,
    password: b.password || guardada.password,
  };
  try {
    res.json(await probarConexion(cfg));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
