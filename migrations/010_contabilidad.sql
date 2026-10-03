-- Contabilidad (PUC colombiano), gastos, activos fijos, IVA y retenciones.
--
-- Los asientos se GENERAN a partir de los documentos (ventas, compras,
-- gastos, recibos, pagos, notas crédito, traslados, depreciación) con
-- src/contabilidad/contabilizar.js; se pueden reconstruir en cualquier momento.
-- Los asientos manuales (aportes de capital, ajustes del contador) tienen
-- origen = 'manual' y nunca se borran en una reconstrucción.

-- ------------------------------------------------------------ plan de cuentas
create table if not exists cuenta (
  codigo text primary key,           -- PUC: 1105, 240801…
  nombre text not null,
  naturaleza text not null check (naturaleza in ('debito', 'credito')),
  grupo text not null                -- activo_corriente | activo_no_corriente | pasivo | patrimonio | ingreso | ingreso_no_operacional | costo | gasto_admin | gasto_ventas | depreciacion | gasto_no_operacional
);

insert into cuenta (codigo, nombre, naturaleza, grupo) values
  ('1105',   'Caja',                                         'debito',  'activo_corriente'),
  ('1110',   'Bancos',                                       'debito',  'activo_corriente'),
  ('1305',   'Clientes',                                     'debito',  'activo_corriente'),
  ('135515', 'Retención en la fuente que nos practicaron',   'debito',  'activo_corriente'),
  ('135517', 'Retención de IVA que nos practicaron',         'debito',  'activo_corriente'),
  ('135518', 'Retención de ICA que nos practicaron',         'debito',  'activo_corriente'),
  ('1435',   'Inventario de mercancías',                     'debito',  'activo_corriente'),
  ('1504',   'Terrenos',                                     'debito',  'activo_no_corriente'),
  ('1516',   'Construcciones y edificaciones',               'debito',  'activo_no_corriente'),
  ('1520',   'Maquinaria y equipo',                          'debito',  'activo_no_corriente'),
  ('1524',   'Equipo de oficina y muebles',                  'debito',  'activo_no_corriente'),
  ('1528',   'Equipo de computación y comunicación',         'debito',  'activo_no_corriente'),
  ('1540',   'Flota y equipo de transporte',                 'debito',  'activo_no_corriente'),
  ('1592',   'Depreciación acumulada',                       'credito', 'activo_no_corriente'),
  ('2205',   'Proveedores nacionales',                       'credito', 'pasivo'),
  ('2335',   'Costos y gastos por pagar',                    'credito', 'pasivo'),
  ('2365',   'Retención en la fuente por pagar',             'credito', 'pasivo'),
  ('2367',   'Retención de IVA por pagar',                   'credito', 'pasivo'),
  ('2368',   'Retención de ICA por pagar',                   'credito', 'pasivo'),
  ('240801', 'IVA generado en ventas',                       'credito', 'pasivo'),
  ('240802', 'IVA descontable en compras y gastos',          'debito',  'pasivo'),
  ('249595', 'Impuesto nacional al consumo (INC) por pagar', 'credito', 'pasivo'),
  ('2895',   'Traslados entre centros de costo',             'credito', 'pasivo'),
  ('3115',   'Aportes sociales (capital)',                   'credito', 'patrimonio'),
  ('4135',   'Ventas (comercio y restaurante)',              'credito', 'ingreso'),
  ('4175',   'Devoluciones en ventas',                       'debito',  'ingreso'),
  ('4210',   'Ingresos financieros',                         'credito', 'ingreso_no_operacional'),
  ('4295',   'Otros ingresos',                               'credito', 'ingreso_no_operacional'),
  ('6135',   'Costo de ventas',                              'debito',  'costo'),
  ('5105',   'Gastos de personal',                           'debito',  'gasto_admin'),
  ('5110',   'Honorarios',                                   'debito',  'gasto_admin'),
  ('5115',   'Impuestos (ICA, predial, 4x1000…)',            'debito',  'gasto_admin'),
  ('5120',   'Arrendamientos',                               'debito',  'gasto_admin'),
  ('5130',   'Seguros',                                      'debito',  'gasto_admin'),
  ('5135',   'Servicios (públicos, transporte, vigilancia…)','debito',  'gasto_admin'),
  ('5140',   'Gastos legales',                               'debito',  'gasto_admin'),
  ('5145',   'Mantenimiento y reparaciones',                 'debito',  'gasto_admin'),
  ('5195',   'Diversos (aseo, papelería, combustible…)',     'debito',  'gasto_admin'),
  ('5235',   'Publicidad y mercadeo',                        'debito',  'gasto_ventas'),
  ('5160',   'Depreciación',                                 'debito',  'depreciacion'),
  ('5305',   'Gastos financieros (bancos, intereses)',       'debito',  'gasto_no_operacional'),
  ('5395',   'Otros gastos no operacionales',                'debito',  'gasto_no_operacional')
on conflict (codigo) do update set nombre = excluded.nombre, naturaleza = excluded.naturaleza, grupo = excluded.grupo;

-- ------------------------------------------------------------------ asientos
create table if not exists asiento (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  fecha date not null,
  origen text not null,               -- factura_venta | nota_credito | compra | recibo_caja | pago_proveedor | traslado | depreciacion | manual
  origen_id uuid,                     -- id del documento (o del activo, para depreciación)
  periodo text,                       -- AAAA-MM (solo depreciación)
  descripcion text,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create index if not exists asiento_empresa_fecha on asiento (empresa_id, fecha);
create unique index if not exists asiento_origen_unico on asiento (origen, origen_id, coalesce(periodo, '')) where origen <> 'manual';

create table if not exists asiento_linea (
  id uuid primary key default gen_random_uuid(),
  asiento_id uuid not null references asiento(id) on delete cascade,
  cuenta text not null references cuenta(codigo),
  tercero_id uuid references tercero(id),
  descripcion text,
  debito numeric(16, 2) not null default 0 check (debito >= 0),
  credito numeric(16, 2) not null default 0 check (credito >= 0)
);
create index if not exists asiento_linea_cuenta on asiento_linea (cuenta);

-- --------------------------------------------------- retenciones (tabla 2026)
-- Decreto 572 de 2025, vigente desde el 1/07/2026. UVT 2026 = $52.374.
create table if not exists concepto_retencion (
  codigo text primary key,
  nombre text not null,
  base_uvt numeric(10, 2) not null default 0,
  tarifa_declarante numeric(6, 3) not null,     -- %
  tarifa_no_declarante numeric(6, 3) not null   -- %
);
insert into concepto_retencion (codigo, nombre, base_uvt, tarifa_declarante, tarifa_no_declarante) values
  ('ninguna',        'No aplica retención',                                0,  0,    0),
  ('compras',        'Compras generales',                                  10, 2.5,  3.5),
  ('agropecuarios',  'Compras de productos agropecuarios sin procesar',    70, 1.5,  1.5),
  ('servicios',      'Servicios generales',                                2,  4,    6),
  ('honorarios',     'Honorarios y comisiones',                            0,  11,   10),
  ('arriendo_inm',   'Arrendamiento de bienes inmuebles',                  10, 3.5,  3.5),
  ('arriendo_mue',   'Arrendamiento de bienes muebles',                    0,  4,    4),
  ('transporte',     'Transporte de carga',                                4,  1,    1),
  ('restaurante',    'Servicios de restaurante y hotel',                   2,  3.5,  3.5),
  ('aseo_vigilancia','Servicios de aseo y vigilancia',                     4,  2,    2),
  ('temporales',     'Servicios temporales de empleo',                     4,  1,    1)
on conflict (codigo) do update set nombre = excluded.nombre, base_uvt = excluded.base_uvt,
  tarifa_declarante = excluded.tarifa_declarante, tarifa_no_declarante = excluded.tarifa_no_declarante;

-- Configuración tributaria por empresa: UVT, si es agente de reteIVA,
-- tarifa de reteICA (por mil) del municipio.
alter table empresa add column if not exists config_tributaria jsonb not null
  default '{"uvt": 52374, "agente_reteiva": false, "reteica_por_mil": 0}';

-- --------------------------------------- compras: IVA, retenciones y gastos
alter table compra add column if not exists clase text not null default 'inventario'; -- inventario | gasto
alter table compra add column if not exists subtotal numeric(14, 2);
alter table compra add column if not exists iva numeric(14, 2) not null default 0;
alter table compra add column if not exists concepto_retencion text references concepto_retencion(codigo);
alter table compra add column if not exists retefuente numeric(14, 2) not null default 0;
alter table compra add column if not exists reteiva numeric(14, 2) not null default 0;
alter table compra add column if not exists reteica numeric(14, 2) not null default 0;
alter table compra add column if not exists descripcion text;
update compra set subtotal = total where subtotal is null;  -- compras anteriores: sin IVA ni retenciones
alter table compra_item add column if not exists iva_pct numeric(5, 2) not null default 0;

-- Renglones de un gasto (o de la compra de un activo fijo).
create table if not exists gasto_item (
  id uuid primary key default gen_random_uuid(),
  compra_id uuid not null references compra(id) on delete cascade,
  tipo text not null default 'gasto' check (tipo in ('gasto', 'activo_fijo')),
  categoria text not null,            -- clave de src/contabilidad/catalogos.js
  cuenta text not null references cuenta(codigo),
  descripcion text,
  valor numeric(14, 2) not null check (valor >= 0),   -- base sin IVA
  iva_pct numeric(5, 2) not null default 0
);

-- Activos fijos (se crean desde un gasto con renglón tipo activo_fijo).
create table if not exists activo_fijo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  gasto_item_id uuid references gasto_item(id) on delete cascade,
  descripcion text not null,
  clase text not null,                -- terreno | construccion | maquinaria | muebles | computo | vehiculo
  cuenta text not null references cuenta(codigo),
  fecha_compra date not null,
  costo numeric(14, 2) not null,
  vida_util_meses integer not null,   -- 0 = no se deprecia (terrenos)
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

-- ------------------------------ recibos: retenciones que nos practican
alter table recibo_caja add column if not exists retefuente numeric(14, 2) not null default 0;
alter table recibo_caja add column if not exists reteiva numeric(14, 2) not null default 0;
alter table recibo_caja add column if not exists reteica numeric(14, 2) not null default 0;
