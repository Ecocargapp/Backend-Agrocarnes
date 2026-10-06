// Parámetros legales de nómina en Colombia. Se actualizan cada año (enero) y
// cuando cambia la ley; cada valor indica su norma.

// Salario mínimo y auxilio de transporte por año (decretos de fin de año).
export const SMMLV = { 2025: 1423500, 2026: 1750905 };           // Decreto 1469 de 2025 (2026)
export const AUX_TRANSPORTE = { 2025: 200000, 2026: 249095 };    // Decreto 1470 de 2025 (2026)
export const UVT = { 2025: 49799, 2026: 52374 };

const ultimo = (tabla, anio) => tabla[anio] ?? tabla[Math.max(...Object.keys(tabla).map(Number).filter((a) => a <= anio))] ?? Object.values(tabla).at(-1);
export const smmlv = (anio) => ultimo(SMMLV, anio);
export const auxTransporte = (anio) => ultimo(AUX_TRANSPORTE, anio);
export const uvt = (anio) => ultimo(UVT, anio);

// Jornada máxima semanal (Ley 2101 de 2021): 46 h desde jul-2023, 44 h desde
// jul-2024, 42 h desde el 15-jul-2026. Horas al mes = horas semana × 5.
export function horasMes(fecha) {
  const f = String(fecha).slice(0, 10);
  if (f >= '2026-07-15') return 210;
  if (f >= '2024-07-15') return 220;
  if (f >= '2023-07-15') return 230;
  return 240;
}

// Recargo dominical y festivo (Ley 2466 de 2025): 80% desde jul-2025,
// 90% desde jul-2026, 100% desde jul-2027.
export function recargoDominical(fecha) {
  const f = String(fecha).slice(0, 10);
  if (f >= '2027-07-01') return 100;
  if (f >= '2026-07-01') return 90;
  if (f >= '2025-07-01') return 80;
  return 75;
}

// Tipos de hora extra y recargo (tabla DIAN / Factus "hora").
//   extra = true → se paga la hora completa + el porcentaje; false → solo el recargo.
export const TIPOS_HORA = {
  1: { nombre: 'Hora extra diurna', extra: true, pct: () => 25 },
  2: { nombre: 'Hora extra nocturna', extra: true, pct: () => 75 },
  3: { nombre: 'Recargo nocturno', extra: false, pct: () => 35 },
  4: { nombre: 'Hora extra diurna dominical/festiva', extra: true, pct: (f) => recargoDominical(f) + 25 },
  5: { nombre: 'Recargo diurno dominical/festivo', extra: false, pct: (f) => recargoDominical(f) },
  6: { nombre: 'Hora extra nocturna dominical/festiva', extra: true, pct: (f) => recargoDominical(f) + 75 },
  7: { nombre: 'Recargo nocturno dominical/festivo', extra: false, pct: (f) => recargoDominical(f) + 35 },
};

// Aportes del trabajador.
export const SALUD_TRABAJADOR = 4;
export const PENSION_TRABAJADOR = 4;
// Fondo de solidaridad pensional (Ley 797 de 2003): IBC ≥ 4 SMMLV.
export function porcentajeFSP(ibc, anio) {
  const n = ibc / smmlv(anio);
  if (n < 4) return 0;
  if (n < 16) return 1;
  if (n < 17) return 1.2;
  if (n < 18) return 1.4;
  if (n < 19) return 1.6;
  if (n < 20) return 1.8;
  return 2;
}

// Aportes del empleador (para la contabilidad). La empresa, como S.A.S.,
// está exonerada de salud, SENA e ICBF por trabajadores que ganan menos de
// 10 SMMLV (art. 114-1 E.T.).
export const PENSION_EMPLEADOR = 12;
export const SALUD_EMPLEADOR = 8.5;
export const CAJA_COMPENSACION = 4;
export const SENA = 2;
export const ICBF = 3;
export const ARL = { 1: 0.522, 2: 1.044, 3: 2.436, 4: 4.35, 5: 6.96 };

// Retención en la fuente por salarios, procedimiento 1 (art. 383 E.T.), en UVT.
export const TABLA_383 = [
  { desde: 0, hasta: 95, tarifa: 0, fijo: 0 },
  { desde: 95, hasta: 150, tarifa: 19, fijo: 0 },
  { desde: 150, hasta: 360, tarifa: 28, fijo: 10 },
  { desde: 360, hasta: 640, tarifa: 33, fijo: 69 },
  { desde: 640, hasta: 945, tarifa: 35, fijo: 162 },
  { desde: 945, hasta: 2300, tarifa: 37, fijo: 268 },
  { desde: 2300, hasta: Infinity, tarifa: 39, fijo: 770 },
];
