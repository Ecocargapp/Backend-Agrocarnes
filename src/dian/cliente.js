// Facturación electrónica a través de Arco ERP.
//
// Flujo por factura:
//   1. La venta se registra local (routes/ventas.js) con estado_dian = 'pendiente'.
//   2. enviarFacturaADian(id) arma el JSON de Arco y hace Factura/Insert → arco_factura_id,
//      estado 'enviada'. Arco numera con su resolución, firma y transmite a la DIAN.
//   3. sincronizarEstado(id) hace Factura/Get: cuando llega FacturaCUFE → 'aceptada';
//      si Arco reporta error en FacturaMsgFE → 'rechazada'.
//   4. Un job (iniciarJobDian) reintenta las 'pendiente'/'error' y refresca las 'enviada'.
//
// Nunca bloquea la venta: cualquier fallo queda en dian_mensaje y se reintenta.

import { pool } from '../db/pool.js';
import { ArcoClient, ArcoError } from './arco.js';
import * as factusFacturas from './facturas-factus.js';

const MAX_INTENTOS = 12;

async function proveedorDe(facturaId) {
  const { rows } = await pool.query(
    `select e.proveedor_dian from factura_venta f join empresa e on e.id = f.empresa_id where f.id = $1`,
    [facturaId]
  );
  return rows[0]?.proveedor_dian || 'arco';
}

async function cargarFactura(facturaId) {
  const { rows } = await pool.query(
    `select f.*, e.arco_config, e.nombre as empresa_nombre,
            t.id as tercero_id, t.nombre as tercero_nombre, t.tipo_documento, t.numero_documento,
            t.email as tercero_email, t.telefono as tercero_telefono, t.direccion as tercero_direccion,
            t.ciudad_id as tercero_ciudad_id, t.arco_tercero_id, t.arco_cliente_id
     from factura_venta f
     join empresa e on e.id = f.empresa_id
     left join tercero t on t.id = f.cliente_id
     where f.id = $1`,
    [facturaId]
  );
  const f = rows[0];
  if (!f) throw new Error(`Factura ${facturaId} no existe`);
  const { rows: items } = await pool.query(
    `select i.cantidad, i.precio_unitario, p.id as producto_id, p.nombre as producto, p.arco_producto_id, p.impuesto_pct
     from factura_venta_item i join producto p on p.id = i.producto_id
     where i.factura_venta_id = $1`,
    [facturaId]
  );
  f.items = items;
  return f;
}

async function marcar(facturaId, estado, extra = {}) {
  const sets = ['estado_dian = $2', 'dian_ultimo_intento = now()'];
  const params = [facturaId, estado];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  await pool.query(`update factura_venta set ${sets.join(', ')} where id = $1`, params);
}

const TIPO_NIT = { NIT: '31', CC: '13', CE: '22', TI: '12', PA: '41', PEP: '47' };

// Devuelve el ClienteId de Arco para la factura: el cliente mapeado, o el
// "consumidor final" configurado, o crea Tercero + Cliente en Arco.
async function resolverClienteArco(arco, f, cfg) {
  if (!f.tercero_id) {
    if (!cfg.cliente_default_id) throw new Error('La empresa no tiene cliente_default_id (consumidor final) configurado en Arco');
    return cfg.cliente_default_id;
  }
  if (f.arco_cliente_id) return f.arco_cliente_id;

  // Buscar por NIT antes de crear.
  if (f.numero_documento) {
    try {
      const lista = await arco.get(`Cliente/List?PageNumber=1&PageSize=5&Nit=${encodeURIComponent(f.numero_documento)}`);
      const existente = (lista.ClienteList || lista.List || lista.Clientes || (Array.isArray(lista) ? lista : []))[0];
      if (existente?.ClienteId) {
        await pool.query('update tercero set arco_cliente_id = $1, arco_tercero_id = coalesce(arco_tercero_id, $2) where id = $3',
          [String(existente.ClienteId), existente.ClienteTerceroId ? String(existente.ClienteTerceroId) : null, f.tercero_id]);
        return String(existente.ClienteId);
      }
    } catch (err) {
      // La búsqueda es opcional; si falla, intentamos crear.
      console.warn('Arco Cliente/List falló, se intenta crear:', err.message);
    }
  }

  let terceroId = f.arco_tercero_id;
  if (!terceroId) {
    const esEmpresa = (f.tipo_documento || '').toUpperCase() === 'NIT';
    const partes = (f.tercero_nombre || '').trim().split(/\s+/);
    const r = await arco.post('Tercero/Insert', {
      Tercero: {
        TipoPersona: esEmpresa ? 'J' : 'N',
        TipoNit: TIPO_NIT[(f.tipo_documento || 'CC').toUpperCase()] || '13',
        Nit: f.numero_documento || '222222222222',
        RazonSocial: f.tercero_nombre,
        TerceroNombreComercial: f.tercero_nombre,
        RLNombre1: esEmpresa ? '' : (partes[0] || ''),
        RLNombre2: esEmpresa ? '' : (partes.length > 3 ? partes[1] : ''),
        RLApellido1: esEmpresa ? '' : (partes.length > 3 ? partes[2] : partes[1] || ''),
        RLApellido2: esEmpresa ? '' : (partes.length > 3 ? partes.slice(3).join(' ') : partes[2] || ''),
        TerceroDireccion: f.tercero_direccion || 'No registra',
        CiudadId: Number(f.tercero_ciudad_id || cfg.ciudad_id || 5001),
        TerceroTelefono: f.tercero_telefono || '',
        TerceroEmail: f.tercero_email || '',
        RegimenRenta: '60',
        RegimenImpIva: esEmpresa ? 'RC' : 'RS',
        TerceroRegimenICA: 'RS',
        TerceroPaisId: 169,
        TerceroEstado: false,
        TerceroTieneRut: esEmpresa,
      },
    });
    terceroId = String(r.TerceroId);
    await pool.query('update tercero set arco_tercero_id = $1 where id = $2', [terceroId, f.tercero_id]);
  }

  const c = await arco.post('Cliente/Insert', {
    ClienteTerceroId: terceroId,
    ClienteDireccion: f.tercero_direccion || 'No registra',
    ClienteEmail: f.tercero_email || '',
    ClienteCiudadId: String(f.tercero_ciudad_id || cfg.ciudad_id || '05001').padStart(5, '0'),
    ClienteTelefono: f.tercero_telefono || '',
    ClienteAlmacen: f.tercero_nombre,
    ClienteEstado: '1',
    ClienteVendedorId: String(cfg.vendedor_id || '0'),
    ClienteRestriccionCredito: 1,
    ClienteCupo: 0,
    ClientePlazo: 0,
    ClienteTipoFlete: 'N',
  });
  const clienteId = String(c.ClienteId);
  await pool.query('update tercero set arco_cliente_id = $1 where id = $2', [clienteId, f.tercero_id]);
  return clienteId;
}

function armarDetalle(f, cfg) {
  const sinCodigo = f.items.filter((i) => !i.arco_producto_id).map((i) => i.producto);
  if (sinCodigo.length) {
    throw new Error(`Productos sin código Arco: ${sinCodigo.join(', ')}. Asígnalo en Inventario → producto.`);
  }
  return f.items.map((i) => {
    const precio = Number(i.precio_unitario);
    const pct = Number(i.impuesto_pct || 0);
    // Arco espera el valor unitario BASE (sin impuesto); el impuesto lo agrega según el producto en Arco.
    const base = cfg.precios_incluyen_impuesto !== false && pct > 0 ? precio / (1 + pct / 100) : precio;
    return {
      ProductoId: i.arco_producto_id,
      FacturaDetalleCantidad: Number(i.cantidad),
      FacturaDetalleVrUnitario: Math.round(base * 100) / 100,
      FacturaDetalleDcto: 0,
      FacturaDetalleTotalPC: 0,
      FacturaDetalleTipoFlete: 'N',
      FacturaDetalleNotaLong: '',
      FacturaLoteId: '0',
    };
  });
}

export async function enviarFacturaADian(facturaId) {
  if ((await proveedorDe(facturaId)) === 'factus') return factusFacturas.enviarFacturaADian(facturaId);
  return enviarFacturaADianArco(facturaId);
}

export async function sincronizarEstado(facturaId) {
  if ((await proveedorDe(facturaId)) === 'factus') return factusFacturas.sincronizarEstado(facturaId);
  return sincronizarEstadoArco(facturaId);
}

async function enviarFacturaADianArco(facturaId) {
  const f = await cargarFactura(facturaId);
  const cfg = f.arco_config;

  if (!cfg?.host) {
    await marcar(facturaId, 'sin_configurar', { dian_mensaje: `${f.empresa_nombre} no tiene configurada la cuenta de Arco` });
    return { estado: 'sin_configurar' };
  }
  if (f.arco_factura_id) return sincronizarEstadoArco(facturaId); // ya está en Arco; solo refrescar

  try {
    const arco = new ArcoClient(cfg);
    const clienteId = await resolverClienteArco(arco, f, cfg);
    const detalle = armarDetalle(f, cfg);
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' }); // YYYY-MM-DD

    const r = await arco.post('Factura/Insert', {
      DocumentoId: Number(cfg.documento_id),
      FacturaResolucionTipo: String(cfg.resolucion_tipo || '04'),
      FacturaNumero: 0,
      FacturaFecha: hoy,
      ClienteId: String(clienteId),
      RetencionICAId: '0',
      RetencionRentaId: '0',
      FacturaOrdenCliente: f.consecutivo || '',
      FacturaOrdenInterna: String(f.id),
      FacturaDctoComercial: 0,
      FacturaPlazoComercial: 0,
      FacturaDctoFinanciero: 0,
      FacturaPlazoFinanciero: 0,
      FacturaTipoOperacion: '1',
      FacturaBodegaId: String(cfg.bodega_id),
      VendedorId: String(cfg.vendedor_id || '0'),
      VehiculoId: '0',
      FacturaNoBultos: 0,
      FacturaTipoPago: String(cfg.tipo_pago || 'E'),
      FacturaVrFlete: 0,
      FacturaVrBolsas: 0,
      FacturaTRM: 1,
      FacturaNotas: `Agrocarnes ${f.consecutivo || ''}`.trim(),
      FacturaSucursalId: String(cfg.sucursal_id),
      FacturaPedidoId: 0,
      FacturaPOSEfectivo: 0, FacturaPOSCheques: 0, FacturaPOSMPT1: 0, FacturaPOSMP1: 0, FacturaPOSMPT2: 0, FacturaPOSMP2: 0,
      FacturaOrigen: 1,
      FacturaCajaId: 0,
      FacturaCCId: 0,
      FacturaGPS: '',
      Detalle: detalle,
    });

    if (!r?.FacturaId) throw new Error(`Arco no devolvió FacturaId: ${JSON.stringify(r).slice(0, 300)}`);
    await marcar(facturaId, 'enviada', { arco_factura_id: String(r.FacturaId), dian_mensaje: null, dian_intentos: 0 });
    return sincronizarEstadoArco(facturaId);
  } catch (err) {
    const intentos = Number(f.dian_intentos || 0) + 1;
    const definitivo = err instanceof ArcoError && err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
    const estado = definitivo || intentos >= MAX_INTENTOS ? 'rechazada' : 'error';
    await marcar(facturaId, estado, { dian_mensaje: err.message.slice(0, 2000), dian_intentos: intentos });
    return { estado, mensaje: err.message };
  }
}

async function sincronizarEstadoArco(facturaId) {
  const f = await cargarFactura(facturaId);
  if (!f.arco_factura_id || !f.arco_config?.host) return { estado: f.estado_dian };
  try {
    const arco = new ArcoClient(f.arco_config);
    const a = await arco.get(`Factura/Get/${f.arco_factura_id}`);
    const cufe = (a.FacturaCUFE || '').trim();
    const msg = (a.FacturaMsgFE || '').trim();
    const extra = {
      consecutivo: a.FacturaId2 || f.consecutivo,
      cufe: cufe || null,
      xml_url: a.FacturaURLFE || null,
      pdf_url: a.FacturaURLFE || null,
      dian_mensaje: msg || null,
      dian_fecha: a.FacturaFechaDIAN && !a.FacturaFechaDIAN.startsWith('0000') ? a.FacturaFechaDIAN : null,
    };
    let estado = 'enviada';
    if (cufe) estado = 'aceptada';
    else if (/rechaz|error|inv[aá]lid/i.test(msg)) estado = 'rechazada';
    await marcar(facturaId, estado, extra);
    return { estado, cufe, mensaje: msg, consecutivo: extra.consecutivo };
  } catch (err) {
    await marcar(facturaId, 'enviada', { dian_mensaje: `Sin respuesta al consultar estado: ${err.message}`.slice(0, 2000) });
    return { estado: 'enviada', mensaje: err.message };
  }
}

// Prueba la conexión y devuelve los catálogos que se necesitan para configurar.
export async function probarConexion(cfg) {
  const arco = new ArcoClient(cfg);
  await arco.login();
  const [suc, bod] = await Promise.all([
    arco.get('Sucursal/List').catch((e) => ({ error: e.message })),
    arco.get('Bodega/List').catch((e) => ({ error: e.message })),
  ]);
  // Las últimas facturas muestran qué DocumentoId / resolución usa la empresa hoy.
  const desde = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const hasta = new Date().toISOString().slice(0, 10);
  const fac = await arco.get(`Factura/List/?PageNumber=1&FacturaDesde=${desde}&FacturaHasta=${hasta}`).catch((e) => ({ error: e.message }));
  const documentos = {};
  for (const x of fac.FacturaList || []) {
    const k = `${x.DocumentoId}`;
    documentos[k] = documentos[k] || { DocumentoId: x.DocumentoId, FacturaResolucionTipo: x.FacturaResolucionTipo, prefijo: x.FacturaPrefijo, sucursal: x.FacturaSucursalNombre, ejemplo: x.FacturaId2, clienteEjemplo: `${x.ClienteId} · ${x.ClienteTerceroNombre}` };
  }
  return {
    ok: true,
    sucursales: (suc.ListSucursal || []).map((s) => ({ id: s.SucursalId, nombre: s.SucursalNombre, bodega: s.SucursalBodegaId, documento_factura: s.SucursalDocFact })),
    bodegas: (bod.ListBodega || []).map((b) => ({ id: b.BodegaId, nombre: b.BodegaNombre, tipo: b.BodegaTipo })),
    documentos_en_uso: Object.values(documentos),
    errores: [suc.error, bod.error, fac.error].filter(Boolean),
  };
}

// Job en segundo plano: reintenta pendientes y refresca las enviadas sin CUFE.
export function iniciarJobDian({ cadaMs = 2 * 60 * 1000 } = {}) {
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const { rows } = await pool.query(
        `select f.id, f.estado_dian from factura_venta f
         join empresa e on e.id = f.empresa_id
         where (e.arco_config is not null or e.factus_config is not null)
           and (
             (f.estado_dian in ('pendiente', 'error', 'sin_configurar') and f.dian_intentos < $1
               and (f.dian_ultimo_intento is null or f.dian_ultimo_intento < now() - interval '2 minutes'))
             or (f.estado_dian = 'enviada' and f.fecha > now() - interval '7 days'
               and (f.dian_ultimo_intento is null or f.dian_ultimo_intento < now() - interval '5 minutes'))
           )
         order by f.fecha asc limit 20`,
        [MAX_INTENTOS]
      );
      for (const r of rows) {
        try {
          if (r.estado_dian === 'enviada') await sincronizarEstado(r.id);
          else await enviarFacturaADian(r.id);
        } catch (err) {
          console.error(`Job DIAN factura ${r.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Job DIAN:', err.message);
    } finally {
      corriendo = false;
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, cadaMs);
}
