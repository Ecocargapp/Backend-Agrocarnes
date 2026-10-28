// Cliente HTTP para la API de Factus (https://developers.factus.com.co).
//
//   const factus = new FactusClient(empresa.factus_config);
//   await factus.post('v2/bills/validate', {...});
//   await factus.get('v2/bills/SETP990000550');
//
// Autenticación: OAuth2 "password grant" → POST oauth/token (form-urlencoded)
//   { access_token, refresh_token, expires_in }. El access_token dura poco
//   (600s en sandbox, 3600s típico en producción), así que se refresca con
//   grant_type=refresh_token, y si eso también falla, se vuelve a hacer login
//   completo con usuario/contraseña. El token se cachea por base_url+client_id.

const tokens = new Map(); // clave: base_url|client_id|email → { access_token, refresh_token, expira }

export class FactusError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export class FactusClient {
  constructor(config) {
    if (!config?.base_url || !config?.client_id || !config?.client_secret || !config?.email || !config?.password) {
      throw new FactusError('Configuración de Factus incompleta: faltan base_url, client_id, client_secret, email o password');
    }
    this.config = config;
    this.base = config.base_url.replace(/\/$/, '') + '/';
    this.key = `${this.base}|${config.client_id}|${config.email}`;
  }

  async login() {
    const res = await fetch(`${this.base}oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        username: this.config.email,
        password: this.config.password,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new FactusError(`Factus rechazó el login (${res.status}): ${JSON.stringify(data).slice(0, 300)}`, { status: res.status, body: data, endpoint: 'oauth/token' });
    }
    this._guardar(data);
    return data.access_token;
  }

  async refrescar(refresh_token) {
    const res = await fetch(`${this.base}oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        refresh_token,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new FactusError(`Factus rechazó el refresh (${res.status})`, { status: res.status, body: data, endpoint: 'oauth/token' });
    this._guardar(data);
    return data.access_token;
  }

  _guardar(data) {
    // Se resta un margen de 30s para no usar un token a punto de expirar.
    const expira = Date.now() + Math.max(0, (Number(data.expires_in) || 600) - 30) * 1000;
    tokens.set(this.key, { access_token: data.access_token, refresh_token: data.refresh_token, expira });
  }

  async token() {
    const t = tokens.get(this.key);
    if (t && Date.now() < t.expira) return t.access_token;
    if (t?.refresh_token) {
      try { return await this.refrescar(t.refresh_token); }
      catch { tokens.delete(this.key); }
    }
    return this.login();
  }

  async request(method, endpoint, body, reintentar = true) {
    const token = await this.token();
    const res = await fetch(this.base + endpoint.replace(/^\//, ''), {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && reintentar) {
      tokens.delete(this.key);
      return this.request(method, endpoint, body, false);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const detalle = typeof data === 'object' ? JSON.stringify(data) : String(data);
      throw new FactusError(`Factus ${method} ${endpoint} → ${res.status}: ${detalle.slice(0, 600)}`, { status: res.status, body: data, endpoint });
    }
    return data;
  }

  // Sube el logo de la empresa (sale en el PDF de las facturas).
  // Factus: PNG/JPG, máx. 300x300 px y menos de 200 KB, campo "image".
  async subirLogo(buffer, nombre = 'logo.png', reintentar = true) {
    const token = await this.token();
    const tipo = /\.jpe?g$/i.test(nombre) ? 'image/jpeg' : 'image/png';
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: tipo }), nombre);
    const res = await fetch(this.base + 'v2/companies/logo', {
      method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, body: form,
    });
    if (res.status === 401 && reintentar) {
      tokens.delete(this.key);
      return this.subirLogo(buffer, nombre, false);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new FactusError(`Factus rechazó el logo (${res.status}): ${JSON.stringify(data).slice(0, 400)}`, { status: res.status, body: data, endpoint: 'v2/companies/logo' });
    return data;
  }

  get(endpoint) { return this.request('GET', endpoint); }
  post(endpoint, body) { return this.request('POST', endpoint, body); }
  delete(endpoint) { return this.request('DELETE', endpoint); }
}

// Quita las credenciales sensibles antes de devolver la configuración al frontend.
export function configPublica(config) {
  if (!config) return null;
  const { client_secret, password, ...resto } = config;
  return { ...resto, client_secret_guardado: Boolean(client_secret), password_guardada: Boolean(password) };
}

// Adquiriente genérico de la DIAN para ventas sin cliente identificado.
export const CONSUMIDOR_FINAL = {
  identification_document_code: '13',
  identification: '222222222222',
  names: 'Consumidor final',
  address: 'No registra',
  legal_organization_code: '2',
  tribute_code: 'ZZ',
};

// Factus guarda cada documento por su reference_code y, si se vuelve a enviar
// el mismo código, responde con el documento que ya tenía (con los datos
// viejos). Una factura o nota rechazada por la DIAN se corrige borrándola en
// Factus (solo se puede si no está validada) y creándola de nuevo. Si no existe
// o ya fue validada, el borrado falla y se ignora: el envío devuelve la vigente.
export async function descartarNoValidado(factus, ruta) {
  try {
    await factus.delete(ruta);
    return true;
  } catch (err) {
    if (err?.status !== 404) console.warn(`[factus] no se pudo borrar ${ruta}: ${err.message}`);
    return false;
  }
}

// Envía a Factus; si responde 409 (documento pendiente por enviar a la DIAN con
// ese mismo reference_code), lo borra y reintenta una vez.
export async function enviarConReintento(factus, endpoint, body, rutaBorrar) {
  try {
    return await factus.post(endpoint, body);
  } catch (err) {
    if (err?.status !== 409) throw err;
    await descartarNoValidado(factus, rutaBorrar);
    return factus.post(endpoint, body);
  }
}

// Dígito de verificación de un NIT (algoritmo DIAN, módulo 11).
export function digitoVerificacion(nit) {
  const n = String(nit || '').replace(/\D/g, '');
  if (!n) return undefined;
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let suma = 0;
  for (let i = 0; i < n.length && i < pesos.length; i++) suma += Number(n[n.length - 1 - i]) * pesos[i];
  const r = suma % 11;
  return String(r > 1 ? 11 - r : r);
}

// Adquiriente (customer) de Factus a partir del tercero. Persona jurídica:
// el nombre va en "company" (razón social) y el NIT con su dígito de
// verificación; persona natural: en "names".
export function adquirienteFactus(d, cfg, TIPO_DOCUMENTO) {
  if (!d.tercero_id) return cfg.cliente_default || CONSUMIDOR_FINAL;
  const tipoDoc = (d.tipo_documento || 'CC').toUpperCase();
  const juridica = d.tercero_tipo_persona === 'juridica' || tipoDoc === 'NIT';
  // Un NIT guardado como "900123456-7" se envía sin el dígito (va aparte en dv).
  let identificacion = String(d.numero_documento || '222222222').trim();
  if (tipoDoc === 'NIT') identificacion = identificacion.split('-')[0].replace(/\D/g, '');
  const nombre = String(d.tercero_razon_social || d.tercero_nombre || '').trim();
  return {
    identification_document_code: TIPO_DOCUMENTO[tipoDoc] || '13',
    identification: identificacion,
    dv: tipoDoc === 'NIT' ? digitoVerificacion(identificacion) : undefined,
    ...(juridica ? { company: nombre } : { names: nombre }),
    address: d.tercero_direccion || 'No registra',
    email: d.tercero_email || undefined,
    phone: d.tercero_telefono || undefined,
    legal_organization_code: juridica ? '1' : '2',
    trade_name: d.tercero_nombre_comercial || undefined,
    tribute_code: d.tercero_regimen_iva === '3' ? '01' : 'ZZ',
    country_code: 'CO',
    municipality_code: d.tercero_ciudad_id || cfg.municipality_code_default || '05001',
  };
}

// Código de tributo DIAN: 01 = IVA, 04 = impuesto nacional al consumo (INC).
export function codigoImpuesto(tipo) {
  return tipo === 'INC' ? '04' : '01';
}

// Medio de pago local → código DIAN (tabla de medios de pago de Factus).
const MEDIO_PAGO = { efectivo: '10', cheque: '20', consignacion: '42', transferencia: '47', pse: '47', tarjeta: '48', tarjeta_credito: '48', tarjeta_debito: '49' };
export function codigoMedioPago(medio, porDefecto) {
  return MEDIO_PAGO[(medio || '').toLowerCase()] || porDefecto || '10';
}

// Factus devuelve `errors` a veces como lista y a veces como objeto
// ({ campo: [mensajes] } o { código: mensaje }); lo aplana a texto.
export function textoErrores(errors) {
  if (!errors) return null;
  const partes = [];
  const recorrer = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach(recorrer);
    else if (typeof v === 'object') Object.values(v).forEach(recorrer);
    else partes.push(String(v));
  };
  recorrer(errors);
  return partes.length ? partes.join(' · ').slice(0, 2000) : null;
}

// Ítems para Factus y el total que Factus va a calcular con ellos (el de
// payment_details debe coincidir exactamente). Las cantidades van con 3
// decimales (kg con gramos); con `decimales = 2` (si Factus no acepta 3) el
// precio unitario se ajusta para que el valor de la línea no cambie.
export function itemsFactus(items, { decimales = 3 } = {}) {
  // Redondeo a centavos sin el ruido de coma flotante (1,70 × 17.847,35 da
  // 30340.494999… en JS y debe dar 30.340,50, como lo calcula Factus).
  const r2 = (n) => Math.round(Number((n * 100).toPrecision(15))) / 100;
  let total = 0;
  const lista = items.map((i) => {
    const cantidad = Number(i.cantidad);
    const precio = Number(i.precio_unitario);
    const pct = Number(i.impuesto_pct || 0);
    const qty = Number(cantidad.toFixed(decimales));
    const baseUnit = pct > 0 ? precio / (1 + pct / 100) : precio;
    // Precio base que, multiplicado por la cantidad enviada, da el valor real de la línea.
    const price = r2(decimales >= 3 ? baseUnit : (baseUnit * cantidad) / (qty || 1));
    const sub = r2(qty * price);
    total += sub + r2(sub * pct / 100);
    return { i, quantity: qty.toFixed(decimales), price: price.toFixed(2), pct };
  });
  return { lista, total: r2(total) };
}

// ¿El 422 de Factus es por la cantidad (decimales)?
export const errorDeCantidad = (err) => err instanceof FactusError && err.status === 422 && /quantity|cantidad/i.test(JSON.stringify(err.body || err.message || ''));
