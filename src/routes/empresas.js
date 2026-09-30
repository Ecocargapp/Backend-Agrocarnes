import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { configPublica } from '../dian/arco.js';
import { probarConexion } from '../dian/cliente.js';
import { configPublica as configPublicaFactus } from '../dian/factus.js';
import { probarConexion as probarConexionFactus, registrarRango } from '../dian/facturas-factus.js';

export const router = Router();

router.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `select id, nombre, nit, es_facturador_dian, prefijo_factura, proveedor_dian,
            (arco_config is not null and arco_config->>'host' is not null) as arco_configurada,
            (factus_config is not null and factus_config->>'client_id' is not null) as factus_configurada
     from empresa order by nombre`
  );
  res.json(rows);
});

// Elige qué proveedor de facturación electrónica usa la empresa (arco | factus).
router.put('/:id/proveedor-dian', requireRole('admin'), async (req, res) => {
  const { proveedor } = req.body || {};
  if (!['arco', 'factus'].includes(proveedor)) return res.status(400).json({ error: 'proveedor debe ser arco o factus' });
  const { rows } = await pool.query('update empresa set proveedor_dian = $1 where id = $2 returning id', [proveedor, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ ok: true, proveedor_dian: proveedor });
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

// --- Factus (nuevo proveedor de facturación electrónica) ---

router.get('/:id/factus', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select nombre, factus_config from empresa where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ empresa: rows[0].nombre, config: configPublicaFactus(rows[0].factus_config) });
});

// Id del rango de numeración en Factus: si el campo viene en el body (aunque
// sea vacío) manda lo que llegó, así se puede borrar; si no viene, se conserva.
function rango(b, anterior, campo) {
  if (!(campo in b)) return anterior[campo] || null;
  const n = Number(b[campo]);
  return b[campo] === '' || b[campo] === null || !Number.isFinite(n) || n <= 0 ? null : n;
}

router.put('/:id/factus', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select factus_config from empresa where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Empresa no encontrada' });
  const anterior = rows[0].factus_config || {};
  const b = req.body || {};
  const config = {
    base_url: (b.base_url || anterior.base_url || 'https://api-sandbox.factus.com.co').trim().replace(/\/$/, ''),
    client_id: (b.client_id || '').trim() || anterior.client_id,
    client_secret: b.client_secret ? String(b.client_secret) : anterior.client_secret, // si viene vacío, se conserva
    email: (b.email || '').trim() || anterior.email,
    password: b.password ? String(b.password) : anterior.password, // si viene vacía, se conserva
    numbering_range_id_factura: rango(b, anterior, 'numbering_range_id_factura'),
    numbering_range_id_nota_credito: rango(b, anterior, 'numbering_range_id_nota_credito'),
    payment_method_code_default: (b.payment_method_code_default || anterior.payment_method_code_default || '10').trim(),
    municipality_code_default: (b.municipality_code_default || anterior.municipality_code_default || '05001').trim(),
    cliente_default: b.cliente_default || anterior.cliente_default || null,
  };
  if (!config.base_url || !config.client_id || !config.client_secret || !config.email || !config.password) {
    return res.status(400).json({ error: 'base_url, client_id, client_secret, email y password son obligatorios' });
  }
  await pool.query('update empresa set factus_config = $1, es_facturador_dian = true where id = $2', [config, req.params.id]);
  res.json({ ok: true, config: configPublicaFactus(config) });
});

router.delete('/:id/factus', requireRole('admin'), async (req, res) => {
  await pool.query('update empresa set factus_config = null where id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Prueba credenciales (las del body, o las guardadas si no se envía password) y
// devuelve los rangos de numeración disponibles para elegir cuál usar.
// Registra en Factus un rango autorizado por la DIAN (prefijo + resolución)
// y, si se pide, lo deja como rango de facturas de esta empresa.
router.post('/:id/factus/rangos', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select factus_config from empresa where id = $1', [req.params.id]);
  const cfg = rows[0]?.factus_config;
  if (!cfg?.client_id) return res.status(400).json({ error: 'La empresa no tiene cuenta de Factus configurada' });
  const { prefijo, resolucion, actual, usar_para_facturas } = req.body || {};
  if (!prefijo || !resolucion) return res.status(400).json({ error: 'Faltan prefijo o resolución' });
  try {
    const rango = await registrarRango(cfg, { prefijo, resolucion, actual });
    if (usar_para_facturas && rango.id) {
      await pool.query(
        `update empresa set factus_config = jsonb_set(factus_config, '{numbering_range_id_factura}', to_jsonb($2::int)) where id = $1`,
        [req.params.id, rango.id]
      );
    }
    res.status(201).json({ ok: true, rango });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Asigna a esta empresa un rango que ya existe en Factus (por su id).
router.put('/:id/factus/rango-factura', requireRole('admin'), async (req, res) => {
  const id = Number(req.body?.rango_id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'rango_id inválido' });
  const { rowCount } = await pool.query(
    `update empresa set factus_config = jsonb_set(factus_config, '{numbering_range_id_factura}', to_jsonb($2::int))
     where id = $1 and factus_config is not null`, [req.params.id, id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Empresa sin cuenta de Factus' });
  res.json({ ok: true });
});

router.post('/:id/factus/probar', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('select factus_config from empresa where id = $1', [req.params.id]);
  const guardada = rows[0]?.factus_config || {};
  const b = req.body || {};
  const cfg = {
    base_url: b.base_url || guardada.base_url || 'https://api-sandbox.factus.com.co',
    client_id: b.client_id || guardada.client_id,
    client_secret: b.client_secret || guardada.client_secret,
    email: b.email || guardada.email,
    password: b.password || guardada.password,
  };
  try {
    res.json(await probarConexionFactus(cfg));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
