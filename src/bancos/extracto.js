// Lectura de extractos bancarios (CSV, o ZIP con el CSV adentro) y
// clasificación de cada movimiento.
//
// Formatos soportados:
//   · Bancolombia (CSV sin encabezado, separado por comas):
//       cuenta, oficina, , AAAAMMDD, , valor, código, descripción, 0,
//     p. ej. "642-000038-02, 642, , 20261009, , -3578.48, 3339, IMPTO GOBIERNO 4X1000, 0,"
//   · Genérico con encabezado: columnas Fecha, Descripción y Valor (o Débito /
//     Crédito), separadas por coma o punto y coma.
import zlib from 'node:zlib';

// ------------------------------------------------------------------ ZIP
// Extrae el primer .csv/.txt de un ZIP (deflate o sin compresión).
export function extraerDeZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('El ZIP no es válido');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const lenNombre = buf.readUInt16LE(p + 28);
    const lenExtra = buf.readUInt16LE(p + 30);
    const lenComent = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.slice(p + 46, p + 46 + lenNombre).toString('utf8');
    p += 46 + lenNombre + lenExtra + lenComent;
    if (!/\.(csv|txt)$/i.test(nombre)) continue;
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.slice(ini, ini + tamComp);
    if (metodo === 0) return { nombre, contenido: datos };
    if (metodo === 8) return { nombre, contenido: zlib.inflateRawSync(datos) };
    throw new Error(`El archivo ${nombre} del ZIP usa una compresión no soportada`);
  }
  throw new Error('El ZIP no trae ningún archivo .csv');
}

// Texto del archivo: UTF-8, o Latin-1 si trae caracteres inválidos.
export function textoDe(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return textoDe(extraerDeZip(buf).contenido);
  const utf = buf.toString('utf8');
  return utf.includes('�') ? buf.toString('latin1') : utf;
}

// ------------------------------------------------------------------ CSV
const limpiar = (s) => String(s ?? '').trim().replace(/^"|"$/g, '').trim();

function partirLinea(linea, sep) {
  const out = []; let cur = ''; let q = false;
  for (const ch of linea) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(limpiar);
}

// "1.234.567,89" | "1,234,567.89" | "-3578.48" | "$ 20.000" → número
export function numero(s) {
  let t = String(s ?? '').replace(/[$\s]/g, '');
  if (!t) return NaN;
  const neg = /^\(.*\)$/.test(t) || t.endsWith('-');
  t = t.replace(/[()]/g, '').replace(/-$/, '');
  const coma = t.lastIndexOf(','); const punto = t.lastIndexOf('.');
  if (coma > punto) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return neg ? -Math.abs(n) : n;
}

function fecha(s) {
  const t = limpiar(s);
  let m = t.match(/^(\d{4})(\d{2})(\d{2})$/) || t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Devuelve { cuenta_banco, movimientos: [{ fecha, valor, codigo, descripcion }] }
export function leerExtracto(texto) {
  const lineas = String(texto).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lineas.length) throw new Error('El archivo está vacío');
  const sep = (lineas[0].match(/;/g) || []).length > (lineas[0].match(/,/g) || []).length ? ';' : ',';
  const primera = partirLinea(lineas[0], sep);
  const movimientos = [];
  let cuenta = null;

  // Bancolombia: 4.ª columna es la fecha AAAAMMDD y la 6.ª el valor.
  if (primera.length >= 8 && /^\d{8}$/.test(primera[3]) && !Number.isNaN(numero(primera[5]))) {
    for (const l of lineas) {
      const c = partirLinea(l, sep);
      if (c.length < 8 || !/^\d{8}$/.test(c[3])) continue;
      cuenta = cuenta || c[0];
      movimientos.push({ fecha: fecha(c[3]), valor: numero(c[5]), codigo: c[6] || null, descripcion: c[7] || 'Sin descripción' });
    }
    return { formato: 'bancolombia', cuenta_banco: cuenta, movimientos: validar(movimientos) };
  }

  // Genérico con encabezado.
  const enc = primera.map((h) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = (...nombres) => enc.findIndex((h) => nombres.some((n) => h.includes(n)));
  const iF = col('fecha'); const iD = col('descripcion', 'concepto', 'detalle', 'transaccion');
  const iV = col('valor', 'monto', 'importe'); const iDeb = col('debito', 'cargo', 'retiro', 'salida');
  const iCre = col('credito', 'abono', 'deposito', 'entrada'); const iCod = col('codigo', 'cod');
  if (iF < 0 || (iV < 0 && iDeb < 0 && iCre < 0)) {
    throw new Error('No reconozco el formato del extracto. Usa el CSV de Bancolombia o un CSV con columnas Fecha, Descripción y Valor (o Débito/Crédito).');
  }
  for (const l of lineas.slice(1)) {
    const c = partirLinea(l, sep);
    const f = fecha(c[iF]);
    if (!f) continue;
    let valor = iV >= 0 ? numero(c[iV]) : NaN;
    if (Number.isNaN(valor)) valor = (iCre >= 0 ? numero(c[iCre]) || 0 : 0) - Math.abs(iDeb >= 0 ? numero(c[iDeb]) || 0 : 0);
    movimientos.push({ fecha: f, valor, codigo: iCod >= 0 ? c[iCod] || null : null, descripcion: (iD >= 0 ? c[iD] : '') || 'Sin descripción' });
  }
  return { formato: 'generico', cuenta_banco: null, movimientos: validar(movimientos) };
}

function validar(movs) {
  const ok = movs.filter((m) => m.fecha && Number.isFinite(m.valor) && m.valor !== 0)
    .map((m) => ({ ...m, valor: Math.round(m.valor * 100) / 100, descripcion: m.descripcion.replace(/\s+/g, ' ').trim() }));
  if (!ok.length) throw new Error('El extracto no trae movimientos');
  return ok;
}

// Huella de cada movimiento: los idénticos del mismo día se numeran en el orden
// del archivo, así al cargar un extracto que se cruza con otro no se duplican.
export function conHuellas(movs) {
  const vistos = new Map();
  return movs.map((m) => {
    const base = `${m.fecha}|${m.valor.toFixed(2)}|${m.codigo || ''}|${m.descripcion.toUpperCase()}`;
    const n = (vistos.get(base) || 0) + 1;
    vistos.set(base, n);
    return { ...m, huella: `${base}|${n}` };
  });
}

// ------------------------------------------------------------ clasificación
// Movimientos financieros que se contabilizan solos y su cuenta.
export const CLASES = {
  gmf:            { nombre: 'Gravamen 4x1000',              cuenta: '51159501', tercero: 'dian' },
  comision:       { nombre: 'Comisiones y gastos bancarios', cuenta: '53051501', tercero: 'banco' },
  iva_bancario:   { nombre: 'IVA de comisiones bancarias',  cuenta: '24080201', tercero: 'banco' },
  interes:        { nombre: 'Intereses de ahorros',         cuenta: '42100501', tercero: 'banco' },
  interes_pagado: { nombre: 'Intereses pagados al banco',   cuenta: '53052001', tercero: 'banco' },
  retencion:      { nombre: 'Retención que nos practicó el banco', cuenta: '13551501', tercero: 'banco' },
};

export function clasificar({ valor, descripcion }) {
  const d = String(descripcion || '').toUpperCase();
  if (/4\s*X\s*1000|GMF|GRAVAMEN/.test(d)) return 'gmf';
  if (/^PAGO A PROVE|^PAGO DE PROV|^TRANSFERENCIA|^TRASLADO|^CONSIGNACION|^ABONO PAGO|^PAGO SUC VIRT|^PAGO PSE/.test(d)) return valor > 0 ? 'ingreso' : 'egreso';
  if (/RETEFUENTE|RETENCION|RTE\.? ?FTE|RETEF/.test(d)) return valor < 0 ? 'retencion' : 'ingreso';
  if (/INTERES/.test(d)) return valor > 0 ? 'interes' : 'interes_pagado';
  if (valor < 0 && /\bIVA\b/.test(d)) return 'iva_bancario';
  if (valor < 0 && /COMISION|CUOTA (DE )?MANEJO|^SERVICIO|^COBRO|^CARGO|TARIFA|CHEQUERA|TALONARIO|EXTRACTO|PORTES|SEGURO/.test(d)) return 'comision';
  return valor > 0 ? 'ingreso' : 'egreso';
}

export const esFinanciero = (clase) => Boolean(CLASES[clase]);

// NIT de los bancos más comunes (tercero del gasto financiero).
const BANCOS = [
  [/BANCOLOMBIA/i, '890903938', 'BANCOLOMBIA S.A.'],
  [/DAVIVIENDA/i, '860034313', 'BANCO DAVIVIENDA S.A.'],
  [/BOGOTA/i, '860002964', 'BANCO DE BOGOTA S.A.'],
  [/OCCIDENTE/i, '890300279', 'BANCO DE OCCIDENTE S.A.'],
  [/BBVA/i, '860003020', 'BBVA COLOMBIA S.A.'],
  [/POPULAR/i, '860007738', 'BANCO POPULAR S.A.'],
  [/AV ?VILLAS/i, '860035827', 'BANCO AV VILLAS S.A.'],
  [/CAJA SOCIAL/i, '860007335', 'BANCO CAJA SOCIAL S.A.'],
  [/AGRARIO/i, '800037800', 'BANCO AGRARIO DE COLOMBIA S.A.'],
  [/SCOTIA|COLPATRIA/i, '860034594', 'SCOTIABANK COLPATRIA S.A.'],
];
export function terceroBanco(nombreCuenta) {
  const b = BANCOS.find(([re]) => re.test(nombreCuenta || ''));
  return b ? { nit: b[1], nit_nombre: b[2] } : { nit: '0', nit_nombre: (nombreCuenta || 'BANCO').toUpperCase() };
}
export const DIAN = { nit: '800197268', nit_nombre: 'DIRECCION DE IMPUESTOS Y ADUANAS NACIONALES DIAN' };
