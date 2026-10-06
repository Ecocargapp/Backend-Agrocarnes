-- Nómina electrónica (DIAN) con Factus.
--
-- empleado        → trabajadores por empresa / centro de costo.
-- nomina          → un documento soporte de pago de nómina por trabajador y
--                   periodo (mensual o quincenal), con las novedades que se
--                   digitaron, la liquidación calculada y el estado ante la DIAN.
-- empresa.nomina_config → cuenta de Factus para nómina (puede ser distinta a
--                   la de facturación, p. ej. el sandbox de habilitación) y
--                   los rangos de numeración de nómina y notas de ajuste.

alter table empresa add column if not exists nomina_config jsonb;
--   nomina_config = {
--     misma_cuenta_factura: true,          -- usa factus_config (mismas credenciales)
--     base_url, client_id, client_secret, email, password,   -- o credenciales propias
--     numbering_range_id_nomina: "...", numbering_range_id_ajuste: "...",
--     usar_empresa_id: "uuid"              -- o la configuración de otra empresa (misma razón social)
--   }

create table if not exists empleado (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  codigo text,                                   -- código interno (employee_code)
  tipo_documento text not null default '13',     -- 13 cédula, 22 cédula de extranjería, 41 pasaporte, 47 PEP…
  numero_documento text not null,
  primer_nombre text not null,
  otros_nombres text,
  primer_apellido text not null,
  segundo_apellido text,
  direccion text not null default 'No registra',
  municipio_codigo text not null default '05887', -- DANE (05887 Yarumal)
  email text,
  telefono text,
  cargo text,
  tipo_trabajador text not null default '01',    -- 01 dependiente, 12/19 aprendiz SENA, 51 tiempo parcial…
  subtipo_trabajador text not null default '00', -- 01 pensionado por vejez activo
  tipo_contrato text not null default '2',       -- 1 fijo, 2 indefinido, 3 obra o labor, 4 aprendizaje, 5 prácticas
  salario numeric(14,2) not null,
  salario_integral boolean not null default false,
  alto_riesgo boolean not null default false,
  clase_riesgo_arl int not null default 1 check (clase_riesgo_arl between 1 and 5),
  periodo_pago text not null default '5' check (periodo_pago in ('4', '5')),  -- 4 quincenal, 5 mensual
  fecha_ingreso date not null,
  fecha_retiro date,
  medio_pago text not null default 'transferencia', -- efectivo | transferencia | consignacion | cheque
  banco text,
  tipo_cuenta text,                              -- 1 nómina, 2 ahorros, 3 corriente
  numero_cuenta text,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);
create unique index if not exists empleado_documento on empleado (empresa_id, tipo_documento, numero_documento);

create table if not exists nomina (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  empleado_id uuid not null references empleado(id),
  anio int not null,
  mes int not null check (mes between 1 and 12),
  periodo text not null default '5',             -- 4 quincenal, 5 mensual
  quincena text,                                 -- 1st | 2nd
  fecha_pago date not null,
  medio_pago text not null default 'transferencia',
  cuenta_pago_id uuid references cuenta_pago(id),
  observacion text,
  empleado_snapshot jsonb not null,              -- datos del trabajador al liquidar
  novedades jsonb not null default '{}',
  liquidacion jsonb not null,                    -- salida de src/nomina/liquidar.js
  total_devengado numeric(14,2) not null,
  total_deducciones numeric(14,2) not null,
  neto numeric(14,2) not null,
  estado text not null default 'vigente',        -- vigente | anulado
  estado_dian text not null default 'pendiente', -- pendiente | aceptada | rechazada | error | sin_configurar
  numero text,                                   -- número asignado por Factus (p. ej. NEF12)
  cune text,
  qr text,
  referencia_envio text,                         -- reference_code enviado a Factus
  dian_intentos int not null default 0,
  dian_mensaje text,
  dian_fecha timestamptz,
  ajuste_numero text,                            -- nota de ajuste (eliminación) si se anuló ante la DIAN
  ajuste_cune text,
  anulado_en timestamptz,
  anulado_por uuid references usuario(id),
  motivo_anulacion text,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create index if not exists nomina_empresa_periodo on nomina (empresa_id, anio, mes);
-- Una sola nómina vigente por trabajador y periodo.
create unique index if not exists nomina_unica_periodo on nomina (empleado_id, anio, mes, periodo, coalesce(quincena, ''))
  where estado = 'vigente';

-- Cuentas del PUC para la nómina.
insert into cuenta (codigo, nombre, naturaleza, grupo) values
  ('510506', 'Sueldos',                                   'debito',  'gasto_admin'),
  ('510515', 'Horas extras y recargos',                   'debito',  'gasto_admin'),
  ('510518', 'Comisiones',                                'debito',  'gasto_admin'),
  ('510524', 'Incapacidades',                             'debito',  'gasto_admin'),
  ('510527', 'Auxilio de transporte',                     'debito',  'gasto_admin'),
  ('510530', 'Cesantías',                                 'debito',  'gasto_admin'),
  ('510533', 'Intereses sobre cesantías',                 'debito',  'gasto_admin'),
  ('510536', 'Prima de servicios',                        'debito',  'gasto_admin'),
  ('510539', 'Vacaciones',                                'debito',  'gasto_admin'),
  ('510545', 'Auxilios',                                  'debito',  'gasto_admin'),
  ('510548', 'Bonificaciones',                            'debito',  'gasto_admin'),
  ('510560', 'Licencias remuneradas',                     'debito',  'gasto_admin'),
  ('510568', 'Aportes a riesgos laborales (ARL)',         'debito',  'gasto_admin'),
  ('510569', 'Aportes a salud (EPS) empleador',           'debito',  'gasto_admin'),
  ('510570', 'Aportes a fondos de pensiones empleador',   'debito',  'gasto_admin'),
  ('510572', 'Aportes cajas de compensación familiar',    'debito',  'gasto_admin'),
  ('510575', 'Aportes ICBF',                              'debito',  'gasto_admin'),
  ('510578', 'SENA',                                      'debito',  'gasto_admin'),
  ('510595', 'Otros gastos de personal',                  'debito',  'gasto_admin'),
  ('236505', 'Retención en la fuente por salarios',       'credito', 'pasivo'),
  ('237005', 'Aportes a salud (EPS) por pagar',           'credito', 'pasivo'),
  ('237006', 'Aportes a riesgos laborales (ARL) por pagar','credito', 'pasivo'),
  ('237010', 'Aportes parafiscales por pagar',            'credito', 'pasivo'),
  ('237030', 'Libranzas y embargos por pagar',            'credito', 'pasivo'),
  ('237045', 'Fondos de cesantías y otros descuentos',    'credito', 'pasivo'),
  ('238030', 'Fondos de pensiones por pagar',             'credito', 'pasivo'),
  ('2505',   'Salarios por pagar',                        'credito', 'pasivo'),
  ('1330',   'Anticipos y avances a trabajadores',        'debito',  'activo_corriente')
on conflict (codigo) do update set nombre = excluded.nombre, naturaleza = excluded.naturaleza, grupo = excluded.grupo;
