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
