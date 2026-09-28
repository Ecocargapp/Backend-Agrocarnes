// Cliente HTTP para la API de Arco ERP (https://documenter.getpostman.com/view/289978/UzJFweL6)
//
//   const arco = new ArcoClient(empresa.arco_config);
//   await arco.post('Factura/Insert', {...});
//   await arco.get('Factura/Get/12345');
//
// Autenticación: POST Security/Login → { Token }; luego header  Authorization: OAuth <Token>
// El token se cachea por host+empresa y se renueva solo si Arco responde 401.

const tokens = new Map(); // clave: host|company|user → { token, obtenido }
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas; si expira antes, el 401 fuerza renovación

export class ArcoError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export class ArcoClient {
  constructor(config) {
    if (!config?.host || !config?.user || !config?.password || !config?.company) {
      throw new ArcoError('Configuración de Arco incompleta: faltan host, company, user o password');
    }
    this.config = config;
    const host = config.host.replace(/\/$/, '');
    this.base = `${/^https?:\/\//.test(host) ? host : `https://${host}`}/ArcoERP/v2/`;
    this.key = `${config.host}|${config.company}|${config.user}`;
  }

  async login() {
    const res = await fetch(`${this.base}Security/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ User: this.config.user, Password: this.config.password, CompanyName: this.config.company }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.Token) {
      throw new ArcoError(`Arco rechazó el login (${res.status}): ${JSON.stringify(data).slice(0, 300)}`, { status: res.status, body: data, endpoint: 'Security/Login' });
    }
    tokens.set(this.key, { token: data.Token, obtenido: Date.now() });
    return data.Token;
  }

  async token() {
    const t = tokens.get(this.key);
    if (t && Date.now() - t.obtenido < TOKEN_TTL_MS) return t.token;
    return this.login();
  }

  async request(method, endpoint, body, reintentar = true) {
    const token = await this.token();
    const res = await fetch(this.base + endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `OAuth ${token}` },
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
      throw new ArcoError(`Arco ${method} ${endpoint} → ${res.status}: ${detalle.slice(0, 500)}`, { status: res.status, body: data, endpoint });
    }
    return data;
  }

  get(endpoint) { return this.request('GET', endpoint); }
  post(endpoint, body) { return this.request('POST', endpoint, body); }
  put(endpoint, body) { return this.request('PUT', endpoint, body); }
}

// Quita la contraseña antes de devolver la configuración al frontend.
export function configPublica(config) {
  if (!config) return null;
  const { password, ...resto } = config;
  return { ...resto, password_guardada: Boolean(password) };
}
