// Catálogos contables: categorías de gasto, clases de activo fijo y cuentas
// de caja/bancos. Las cuentas existen en la tabla `cuenta` (migración 010).

// Categorías de gasto → cuenta PUC y concepto de retención sugerido.
export const CATEGORIAS_GASTO = {
  nomina:          { nombre: 'Nómina y prestaciones',          cuenta: '5105', retencion: 'ninguna' },
  honorarios:      { nombre: 'Honorarios (contador, abogado…)', cuenta: '5110', retencion: 'honorarios' },
  impuestos:       { nombre: 'Impuestos (ICA, predial, 4x1000)', cuenta: '5115', retencion: 'ninguna' },
  arriendo:        { nombre: 'Arriendo del local',              cuenta: '5120', retencion: 'arriendo_inm' },
  arriendo_equipo: { nombre: 'Alquiler de equipos',             cuenta: '5120', retencion: 'arriendo_mue' },
  seguros:         { nombre: 'Seguros',                         cuenta: '5130', retencion: 'ninguna' },
  servicios_pub:   { nombre: 'Servicios públicos (luz, agua, gas, internet)', cuenta: '5135', retencion: 'ninguna' },
  transporte:      { nombre: 'Transporte y fletes',             cuenta: '5135', retencion: 'transporte' },
  aseo_vigilancia: { nombre: 'Aseo y vigilancia (contratados)', cuenta: '5135', retencion: 'aseo_vigilancia' },
  otros_servicios: { nombre: 'Otros servicios',                 cuenta: '5135', retencion: 'servicios' },
  legales:         { nombre: 'Gastos legales (cámara de comercio, notaría)', cuenta: '5140', retencion: 'ninguna' },
  mantenimiento:   { nombre: 'Mantenimiento y reparaciones',    cuenta: '5145', retencion: 'servicios' },
  publicidad:      { nombre: 'Publicidad y mercadeo',           cuenta: '5235', retencion: 'servicios' },
  aseo_cafeteria:  { nombre: 'Elementos de aseo y cafetería',   cuenta: '5195', retencion: 'compras' },
  papeleria:       { nombre: 'Útiles y papelería',              cuenta: '5195', retencion: 'compras' },
  combustible:     { nombre: 'Combustible',                     cuenta: '5195', retencion: 'ninguna' },
  dotacion:        { nombre: 'Dotación y uniformes',            cuenta: '5195', retencion: 'compras' },
  bancarios:       { nombre: 'Gastos bancarios y comisiones',   cuenta: '5305', retencion: 'ninguna' },
  intereses:       { nombre: 'Intereses de créditos',           cuenta: '5305', retencion: 'ninguna' },
  otros:           { nombre: 'Otros gastos',                    cuenta: '5195', retencion: 'ninguna' },
};

// Clases de activo fijo → cuenta y vida útil fiscal (art. 137 E.T.).
export const CLASES_ACTIVO = {
  terreno:      { nombre: 'Terrenos (no se deprecian)',            cuenta: '1504', vida_util_meses: 0 },
  construccion: { nombre: 'Construcciones y edificaciones',        cuenta: '1516', vida_util_meses: 540 },
  maquinaria:   { nombre: 'Maquinaria y equipo (neveras, hornos…)', cuenta: '1520', vida_util_meses: 120 },
  muebles:      { nombre: 'Muebles y equipo de oficina',           cuenta: '1524', vida_util_meses: 120 },
  computo:      { nombre: 'Equipo de cómputo y comunicación',      cuenta: '1528', vida_util_meses: 60 },
  vehiculo:     { nombre: 'Vehículos',                             cuenta: '1540', vida_util_meses: 120 },
};

// Medio de pago → cuenta de disponible.
export const cuentaDisponible = (medio) => ((medio || 'efectivo') === 'efectivo' ? '1105' : '1110');
