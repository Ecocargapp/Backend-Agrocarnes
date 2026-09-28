-- Cartera (cuentas por cobrar y por pagar), notas crédito y anulaciones.

-- ---------------------------------------------------------------- ventas
alter table factura_venta add column if not exists forma_pago text not null default 'contado'; -- contado | credito
alter table factura_venta add column if not exists fecha_vencimiento date;
alter table factura_venta add column if not exists saldo numeric(14, 2) not null default 0; -- lo que falta por cobrar
alter table factura_venta add column if not exists estado text not null default 'vigente'; -- vigente | anulada
alter table factura_venta add column if not exists anulada_en timestamptz;
alter table factura_venta add column if not exists anulada_por uuid references usuario(id);
alter table factura_venta add column if not exists motivo_anulacion text;
alter table factura_venta add column if not exists creado_por uuid references usuario(id);

-- Las facturas ya existentes se consideran de contado y pagadas.
update factura_venta set saldo = 0 where saldo is null;

-- --------------------------------------------------------------- compras
alter table compra add column if not exists forma_pago text not null default 'contado';
alter table compra add column if not exists fecha_vencimiento date;
alter table compra add column if not exists saldo numeric(14, 2) not null default 0; -- lo que falta por pagar
alter table compra add column if not exists creado_por uuid references usuario(id);

-- ------------------------------------------------- recibos de caja (cobros)
create table if not exists recibo_caja (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  tercero_id uuid references tercero(id),
  consecutivo integer,
  fecha date not null default current_date,
  medio_pago text not null default 'efectivo', -- efectivo | transferencia | tarjeta | otro
  total numeric(14, 2) not null,
  notas text,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create table if not exists recibo_caja_aplicacion (
  id uuid primary key default gen_random_uuid(),
  recibo_caja_id uuid not null references recibo_caja(id) on delete cascade,
  factura_venta_id uuid not null references factura_venta(id),
  valor numeric(14, 2) not null check (valor > 0)
);
create index if not exists recibo_aplicacion_factura on recibo_caja_aplicacion (factura_venta_id);

-- ------------------------------------------------ pagos a proveedores
create table if not exists pago_proveedor (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  tercero_id uuid not null references tercero(id),
  consecutivo integer,
  fecha date not null default current_date,
  medio_pago text not null default 'transferencia',
  total numeric(14, 2) not null,
  notas text,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create table if not exists pago_proveedor_aplicacion (
  id uuid primary key default gen_random_uuid(),
  pago_proveedor_id uuid not null references pago_proveedor(id) on delete cascade,
  compra_id uuid not null references compra(id),
  valor numeric(14, 2) not null check (valor > 0)
);
create index if not exists pago_aplicacion_compra on pago_proveedor_aplicacion (compra_id);

alter table empresa add column if not exists ultimo_recibo integer not null default 0;
alter table empresa add column if not exists ultimo_pago integer not null default 0;
alter table empresa add column if not exists ultimo_nota_credito integer not null default 0;

-- ---------------------------------------------------------- notas crédito
create table if not exists nota_credito (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  factura_venta_id uuid not null references factura_venta(id),
  consecutivo text,
  fecha timestamptz not null default now(),
  razon integer not null, -- códigos DIAN/Arco: 1 devolución parcial · 2 anulación · 3 rebaja/descuento · 4 ajuste de precio · 5 dcto pronto pago · 6 dcto volumen
  reingresa_inventario boolean not null default false,
  bodega_id uuid references bodega(id),
  total numeric(14, 2) not null,
  notas text,
  estado_dian text not null default 'pendiente',
  arco_nota_id text,
  cufe text,
  pdf_url text,
  dian_mensaje text,
  dian_intentos integer not null default 0,
  dian_ultimo_intento timestamptz,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create table if not exists nota_credito_item (
  id uuid primary key default gen_random_uuid(),
  nota_credito_id uuid not null references nota_credito(id) on delete cascade,
  producto_id uuid not null references producto(id),
  cantidad numeric(14, 3) not null,
  precio_unitario numeric(14, 2) not null
);

-- Nuevos tipos de movimiento de inventario.
alter table movimiento_inventario drop constraint if exists movimiento_inventario_tipo_check;
alter table movimiento_inventario add constraint movimiento_inventario_tipo_check check (tipo in (
  'compra',
  'porcionado_entrada', 'porcionado_salida',
  'traslado_salida', 'traslado_entrada',
  'produccion_consumo', 'produccion_entrada',
  'venta',
  'devolucion_venta',   -- nota crédito con reingreso
  'anulacion_venta'     -- reversión de una factura anulada
));
