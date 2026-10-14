-- Conciliación bancaria: extractos importados (CSV del banco) y sus movimientos.
--
-- Cada movimiento del banco queda:
--   pendiente     → todavía no se encontró en los libros
--   conciliado    → corresponde a un documento ya contabilizado contra la
--                   cuenta del banco (recibo de caja, egreso, nómina…)
--   contabilizado → no tenía documento y se contabilizó desde el extracto
--                   (gastos financieros, intereses, 4x1000 o contrapartida elegida)

create table if not exists extracto_bancario (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  cuenta_pago_id uuid not null references cuenta_pago(id),
  archivo text,
  cuenta_banco text,                    -- número de cuenta que trae el archivo
  desde date,
  hasta date,
  saldo_final numeric(16,2),            -- opcional: saldo final según el extracto
  movimientos int not null default 0,
  nuevos int not null default 0,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);

create table if not exists movimiento_bancario (
  id uuid primary key default gen_random_uuid(),
  extracto_id uuid not null references extracto_bancario(id) on delete cascade,
  empresa_id uuid not null references empresa(id),
  cuenta_pago_id uuid not null references cuenta_pago(id),
  fecha date not null,
  valor numeric(16,2) not null,         -- + entra dinero, − sale
  codigo text,                          -- código de transacción del banco
  descripcion text not null,
  huella text not null,                 -- evita duplicados al cargar extractos que se cruzan
  clase text not null,                  -- ingreso | egreso | gmf | comision | iva_bancario | interes | interes_pagado | retencion
  estado text not null default 'pendiente' check (estado in ('pendiente', 'conciliado', 'contabilizado')),
  libro_origen text,                    -- documento con el que concilia (asiento.origen / origen_id)
  libro_origen_id uuid,
  contrapartida text,                   -- cuenta usada al contabilizar desde el extracto
  contrapartida_tercero_id uuid references tercero(id),
  automatico boolean not null default false,
  nota text,
  conciliado_en timestamptz,
  conciliado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create unique index if not exists movimiento_bancario_huella on movimiento_bancario (cuenta_pago_id, huella);
create index if not exists movimiento_bancario_cuenta_fecha on movimiento_bancario (cuenta_pago_id, fecha);
create unique index if not exists movimiento_bancario_libro on movimiento_bancario (libro_origen, libro_origen_id) where libro_origen is not null;

-- Cuentas para los gastos e ingresos financieros del extracto.
insert into cuenta (codigo, nombre, naturaleza, grupo) values
  ('51159501', 'GRAVAMEN A LOS MOVIMIENTOS FINANCIEROS (4X1000)', 'debito', 'gasto_admin'),
  ('53050501', 'GASTOS BANCARIOS', 'debito', 'gasto_no_operacional'),
  ('53051501', 'COMISIONES BANCARIAS', 'debito', 'gasto_no_operacional'),
  ('53052001', 'INTERESES BANCARIOS', 'debito', 'gasto_no_operacional'),
  ('42100501', 'INTERESES BANCARIOS', 'credito', 'ingreso_no_operacional'),
  ('28050501', 'INGRESOS RECIBIDOS POR IDENTIFICAR', 'credito', 'pasivo'),
  ('42959501', 'OTROS INGRESOS DIVERSOS', 'credito', 'ingreso_no_operacional'),
  ('53959501', 'OTROS GASTOS DIVERSOS', 'debito', 'gasto_no_operacional')
on conflict (codigo) do nothing;
