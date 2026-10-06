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
