// Liquidación de nómina de un trabajador en un periodo (función pura, sin BD).
//
//   liquidar({ empleado, anio, mes, periodo: '5' | '4', quincena: '1st' | '2nd', novedades })
//
// Devuelve los devengados y deducciones (con los códigos de la DIAN que usa
// Factus), los totales, el IBC y los aportes del empleador para la
// contabilidad. Los valores se redondean al peso.
//
// novedades = {
//   horas:          [{ tipo: 1..7, cantidad, fecha?, inicio?: 'AAAA-MM-DDTHH:MM', fin? }],
//   vacaciones:     [{ tipo: 1 comunes | 2 compensadas, dias, desde?, hasta?, valor? }],
//   licencias:      [{ tipo: 1 maternidad/paternidad | 2 remunerada | 3 no remunerada, dias, desde?, hasta? }],
//   incapacidades:  [{ tipo: 1 común | 2 profesional | 3 laboral, dias, desde?, hasta?, valor? }],
//   prima:          { dias?, valor? }        (dias por defecto: los del semestre hasta el fin del periodo)
//   cesantias:      { dias?, valor?, intereses?: true }  (dias por defecto: los del año)
//   bonificaciones: [{ valor, salarial? }],  comisiones: [{ valor }],
//   auxilios:       [{ valor, salarial? }],  otros: [{ descripcion, valor, salarial? }],
//   deducciones:    { libranzas: [{ descripcion, valor }], anticipos: [{ valor }], otras: [{ valor, descripcion? }],
//                     sindicato_pct?, pension_voluntaria?, afc?, retencion? (si se da, reemplaza el cálculo) }
// }
import * as P from './parametros.js';

const peso = (n) => Math.round(Number(n || 0));
const iso = (d) => d.toISOString().slice(0, 10);

function ultimoDiaMes(anio, mes) { return new Date(Date.UTC(anio, mes, 0)).getUTCDate(); }

// Días entre dos fechas (inclusive) con mes comercial de 30 días.
export function dias360(desde, hasta) {
  const [y1, m1, d1] = desde.split('-').map(Number);
  const [y2, m2, d2] = hasta.split('-').map(Number);
  const a = Math.min(d1, 30);
  let b = Math.min(d2, 30);
  if (m2 === 2 && d2 === ultimoDiaMes(y2, 2)) b = 30; // fin de febrero cuenta como 30
  return Math.max(0, (y2 - y1) * 360 + (m2 - m1) * 30 + (b - a) + 1);
}

export function rangoPeriodo(anio, mes, periodo = '5', quincena = null) {
  const m = String(mes).padStart(2, '0');
  const fin = ultimoDiaMes(anio, mes);
  if (String(periodo) === '4') {
    return quincena === '2nd'
      ? { inicio: `${anio}-${m}-16`, fin: `${anio}-${m}-${fin}`, dias: 15 }
      : { inicio: `${anio}-${m}-01`, fin: `${anio}-${m}-15`, dias: 15 };
  }
  return { inicio: `${anio}-${m}-01`, fin: `${anio}-${m}-${fin}`, dias: 30 };
}

const suma = (arr, f = (x) => x) => (arr || []).reduce((a, x) => a + Number(f(x) || 0), 0);

export function liquidar({ empleado, anio, mes, periodo = '5', quincena = null, novedades = {} }) {
  anio = Number(anio); mes = Number(mes);
  const salario = Number(empleado.salario);
  if (!(salario > 0)) throw new Error('El trabajador no tiene salario');
  const integral = Boolean(empleado.salario_integral);
  const aprendiz = ['12', '19'].includes(String(empleado.tipo_trabajador || '01'));
  const pensionado = String(empleado.subtipo_trabajador || '00') === '01';
  const smlv = P.smmlv(anio);
  const rango = rangoPeriodo(anio, mes, periodo, quincena);
  const ingreso = String(empleado.fecha_ingreso).slice(0, 10);
  const retiro = empleado.fecha_retiro ? String(empleado.fecha_retiro).slice(0, 10) : null;
  if (ingreso > rango.fin) throw new Error('El trabajador ingresó después del periodo');
  if (retiro && retiro < rango.inicio) throw new Error('El trabajador se retiró antes del periodo');

  const desde = ingreso > rango.inicio ? ingreso : rango.inicio;
  const hasta = retiro && retiro < rango.fin ? retiro : rango.fin;
  let diasActivo = Math.min(rango.dias, dias360(desde, hasta));
  if (hasta === rango.fin && desde === rango.inicio) diasActivo = rango.dias;

  const n = novedades || {};
  const diario = salario / 30;
  const vacaciones = (n.vacaciones || []).filter((v) => Number(v.dias) > 0);
  const licencias = (n.licencias || []).filter((v) => Number(v.dias) > 0);
  const incapacidades = (n.incapacidades || []).filter((v) => Number(v.dias) > 0);

  const diasVacDisfrutadas = suma(vacaciones.filter((v) => Number(v.tipo || 1) === 1), (v) => v.dias);
  const diasLicNoRem = suma(licencias.filter((l) => Number(l.tipo) === 3), (l) => l.dias);
  const diasLicRem = suma(licencias.filter((l) => Number(l.tipo) !== 3), (l) => l.dias);
  const diasInc = suma(incapacidades, (i) => i.dias);
  const diasTrabajados = Math.max(0, diasActivo - diasLicNoRem);           // lo que se reporta a la DIAN
  const diasLaborados = Math.max(0, diasActivo - diasVacDisfrutadas - diasLicNoRem - diasLicRem - diasInc);
  if (diasVacDisfrutadas + diasLicNoRem + diasLicRem + diasInc > diasActivo) {
    throw new Error(`Las novedades suman más días (${diasVacDisfrutadas + diasLicNoRem + diasLicRem + diasInc}) que los del periodo (${diasActivo})`);
  }

  const dev = [];   // { clave, codigo, nombre, cantidad?, porcentaje?, valor, salarial, ... }
  const sueldo = peso(diario * diasLaborados);
  dev.push({ clave: 'suel', codigo: '1', nombre: 'Sueldo', cantidad: diasLaborados, valor: sueldo, salarial: true });

  // Auxilio de transporte: hasta 2 SMMLV, por los días efectivamente laborados.
  const tieneAux = !integral && !aprendiz && salario <= 2 * smlv;
  if (tieneAux && diasLaborados > 0) {
    dev.push({ clave: 'tra', codigo: '1', nombre: 'Auxilio de transporte', cantidad: diasLaborados, valor: peso(P.auxTransporte(anio) / 30 * diasLaborados), salarial: false });
  }

  // Horas extra y recargos.
  for (const h of n.horas || []) {
    const tipo = P.TIPOS_HORA[Number(h.tipo)];
    if (!tipo || !(Number(h.cantidad) > 0)) continue;
    const fecha = (h.fecha || h.inicio || rango.fin).slice(0, 10);
    const valorHora = salario / P.horasMes(fecha);
    const pct = tipo.pct(fecha);
    const factor = tipo.extra ? 1 + pct / 100 : pct / 100;
    dev.push({
      clave: 'hora', codigo: String(h.tipo), nombre: tipo.nombre, cantidad: Number(h.cantidad), porcentaje: pct,
      valor: peso(valorHora * factor * Number(h.cantidad)), salarial: true, inicio: h.inicio || null, fin: h.fin || null,
    });
  }

  for (const v of vacaciones) {
    const tipo = Number(v.tipo || 1);
    dev.push({ clave: 'vaca', codigo: String(tipo), nombre: tipo === 2 ? 'Vacaciones compensadas' : 'Vacaciones', cantidad: Number(v.dias),
      valor: peso(v.valor ?? diario * Number(v.dias)), salarial: tipo === 1, desde: v.desde || null, hasta: v.hasta || null });
  }
  for (const l of licencias) {
    const tipo = Number(l.tipo);
    const nombre = { 1: 'Licencia de maternidad o paternidad', 2: 'Licencia remunerada', 3: 'Licencia no remunerada' }[tipo];
    dev.push({ clave: 'lice', codigo: String(tipo), nombre, cantidad: Number(l.dias),
      valor: tipo === 3 ? 0 : peso(l.valor ?? diario * Number(l.dias)), salarial: tipo !== 3, desde: l.desde || null, hasta: l.hasta || null });
  }
  for (const i of incapacidades) {
    const tipo = Number(i.tipo || 1);
    // Común: 2/3 del salario diario, nunca menos de un SMMLV diario. Laboral/profesional: 100%.
    const dia = tipo === 1 ? Math.max(diario * 2 / 3, smlv / 30) : diario;
    const nombre = { 1: 'Incapacidad común', 2: 'Incapacidad profesional', 3: 'Incapacidad laboral' }[tipo];
    dev.push({ clave: 'inca', codigo: String(tipo), nombre, cantidad: Number(i.dias), valor: peso(i.valor ?? dia * Number(i.dias)),
      salarial: true, desde: i.desde || null, hasta: i.hasta || null });
  }

  // Prestaciones (base = salario + auxilio de transporte si aplica).
  const basePrest = salario + (tieneAux ? P.auxTransporte(anio) : 0);
  if (n.prima && !integral) {
    const iniSem = mes <= 6 ? `${anio}-01-01` : `${anio}-07-01`;
    const dias = Number(n.prima.dias) || dias360(ingreso > iniSem ? ingreso : iniSem, hasta);
    dev.push({ clave: 'prim', codigo: '1', nombre: 'Prima de servicios', cantidad: dias, valor: peso(n.prima.valor ?? basePrest * dias / 360), salarial: false });
  }
  if (n.cesantias && !integral) {
    const iniAnio = `${anio}-01-01`;
    const dias = Number(n.cesantias.dias) || dias360(ingreso > iniAnio ? ingreso : iniAnio, hasta);
    const ces = peso(n.cesantias.valor ?? basePrest * dias / 360);
    dev.push({ clave: 'cesa', codigo: '1', nombre: 'Cesantías', cantidad: dias, valor: ces, salarial: false });
    if (n.cesantias.intereses !== false) {
      dev.push({ clave: 'cesa', codigo: '2', nombre: 'Intereses a las cesantías', cantidad: dias, porcentaje: 12, valor: peso(ces * 0.12 * dias / 360), salarial: false });
    }
  }
  for (const c of n.comisiones || []) if (Number(c.valor) > 0) dev.push({ clave: 'comi', codigo: '1', nombre: 'Comisión', valor: peso(c.valor), salarial: true });
  for (const b of n.bonificaciones || []) if (Number(b.valor) > 0) dev.push({ clave: 'boni', codigo: b.salarial ? '1' : '2', nombre: b.salarial ? 'Bonificación salarial' : 'Bonificación no salarial', valor: peso(b.valor), salarial: Boolean(b.salarial) });
  for (const a of n.auxilios || []) if (Number(a.valor) > 0) dev.push({ clave: 'auxi', codigo: a.salarial ? '1' : '2', nombre: a.salarial ? 'Auxilio salarial' : 'Auxilio no salarial', valor: peso(a.valor), salarial: Boolean(a.salarial) });
  for (const o of n.otros || []) if (Number(o.valor) > 0) dev.push({ clave: 'otro', codigo: o.salarial ? '1' : '2', nombre: o.descripcion || 'Otro concepto', descripcion: o.descripcion || 'Otro concepto', valor: peso(o.valor), salarial: Boolean(o.salarial) });

  const totalDevengado = suma(dev, (d) => d.valor);

  // IBC: devengados salariales (vacaciones compensadas, prima, cesantías y
  // auxilio de transporte no hacen base). Mínimo 1 SMMLV proporcional, máximo 25.
  const salariales = suma(dev.filter((d) => d.salarial), (d) => d.valor);
  let ibc = integral ? salariales * 0.7 : salariales;
  const diasCotizados = Math.max(0, diasActivo - diasLicNoRem);
  ibc = Math.min(Math.max(ibc, smlv / 30 * diasCotizados), 25 * smlv);
  ibc = peso(ibc);

  const ded = [];
  if (!aprendiz && ibc > 0) {
    ded.push({ clave: 'salu', codigo: '1', nombre: 'Salud', porcentaje: P.SALUD_TRABAJADOR, valor: peso(ibc * P.SALUD_TRABAJADOR / 100) });
    if (!pensionado) {
      ded.push({ clave: 'pens', codigo: '1', nombre: 'Pensión', porcentaje: P.PENSION_TRABAJADOR, valor: peso(ibc * P.PENSION_TRABAJADOR / 100) });
      // FSP sobre el IBC mensual equivalente.
      const pctFsp = P.porcentajeFSP(ibc * 30 / Math.max(1, diasCotizados), anio);
      if (pctFsp > 0) ded.push({ clave: 'dedu', codigo: '1', nombre: 'Fondo de solidaridad pensional', porcentaje: pctFsp, valor: peso(ibc * pctFsp / 100) });
    }
  }
  const d = n.deducciones || {};
  if (Number(d.sindicato_pct) > 0) ded.push({ clave: 'sind', codigo: '1', nombre: 'Cuota sindical', porcentaje: Number(d.sindicato_pct), valor: peso(salariales * Number(d.sindicato_pct) / 100) });
  if (Number(d.pension_voluntaria) > 0) ded.push({ clave: 'pevo', codigo: '1', nombre: 'Pensión voluntaria', valor: peso(d.pension_voluntaria) });
  if (Number(d.afc) > 0) ded.push({ clave: 'afco', codigo: '1', nombre: 'Ahorro AFC', valor: peso(d.afc) });
  for (const l of d.libranzas || []) if (Number(l.valor) > 0) ded.push({ clave: 'libr', codigo: '1', nombre: 'Libranza', descripcion: l.descripcion || 'Libranza', valor: peso(l.valor) });
  for (const a of d.anticipos || []) if (Number(a.valor) > 0) ded.push({ clave: 'anti', codigo: '1', nombre: 'Anticipo de nómina', valor: peso(a.valor) });
  for (const o of d.otras || []) if (Number(o.valor) > 0) ded.push({ clave: 'otra', codigo: '1', nombre: o.descripcion || 'Otra deducción', valor: peso(o.valor) });

  // Retención en la fuente (procedimiento 1).
  const aportesObligatorios = suma(ded.filter((x) => ['salu', 'pens', 'dedu'].includes(x.clave)), (x) => x.valor);
  const exentosLey = suma(dev.filter((x) => x.clave === 'cesa'), (x) => x.valor);
  const retencion = d.retencion != null && d.retencion !== ''
    ? peso(d.retencion)
    : calcularRetencion({ ingresos: totalDevengado - exentosLey, aportes: aportesObligatorios, voluntarios: Number(d.pension_voluntaria || 0) + Number(d.afc || 0), anio });
  if (retencion > 0) ded.push({ clave: 'rete', codigo: '1', nombre: 'Retención en la fuente', valor: retencion });

  const totalDeducciones = suma(ded, (x) => x.valor);

  // Aportes del empleador (no salen en la nómina electrónica, sí en la contabilidad).
  const exonerado = ibc * 30 / Math.max(1, diasCotizados) < 10 * smlv;
  const baseParafiscal = suma(dev.filter((x) => x.salarial || (x.clave === 'vaca')), (x) => x.valor);
  const aportes = aprendiz ? { salud: peso(ibc * 12.5 / 100), pension: 0, arl: peso(ibc * P.ARL[1] / 100), caja: 0, sena: 0, icbf: 0 } : {
    salud: exonerado ? 0 : peso(ibc * P.SALUD_EMPLEADOR / 100),
    pension: pensionado ? 0 : peso(ibc * P.PENSION_EMPLEADOR / 100),
    arl: peso(ibc * (P.ARL[Number(empleado.clase_riesgo_arl) || 1]) / 100),
    caja: peso((integral ? baseParafiscal * 0.7 : baseParafiscal) * P.CAJA_COMPENSACION / 100),
    sena: exonerado ? 0 : peso(ibc * P.SENA / 100),
    icbf: exonerado ? 0 : peso(ibc * P.ICBF / 100),
  };

  return {
    periodo: { ...rango, anio, mes, codigo: String(periodo), quincena: String(periodo) === '4' ? (quincena || '1st') : null },
    dias_trabajados: diasTrabajados,
    dias_laborados: diasLaborados,
    salario,
    ibc,
    devengados: dev.filter((x) => x.valor > 0 || x.clave === 'lice' || x.clave === 'suel'),
    deducciones: ded.filter((x) => x.valor > 0),
    total_devengado: totalDevengado,
    total_deducciones: totalDeducciones,
    neto: totalDevengado - totalDeducciones,
    aportes,
  };
}

export function calcularRetencion({ ingresos, aportes, voluntarios = 0, anio }) {
  const u = P.uvt(anio);
  const neto = Math.max(0, ingresos - aportes);
  if (neto <= 0) return 0;
  const exenta = Math.min(neto * 0.25, 790 / 12 * u);
  const limite = Math.min(neto * 0.4, 1340 / 12 * u);       // tope de rentas exentas + deducciones
  const depurado = neto - Math.min(exenta + voluntarios, limite);
  const baseUvt = depurado / u;
  const fila = P.TABLA_383.find((f) => baseUvt > f.desde && baseUvt <= f.hasta) || P.TABLA_383[0];
  const impuestoUvt = fila.tarifa ? (baseUvt - fila.desde) * fila.tarifa / 100 + fila.fijo : 0;
  return Math.round(impuestoUvt * u / 1000) * 1000;   // se aproxima al múltiplo de 1.000
}

export { iso };
