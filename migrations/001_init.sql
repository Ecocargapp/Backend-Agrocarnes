-- Agrocarnes · migración inicial
-- Modelo multiempresa: Agrocarnes, Restaurante y D'Monsa comparten esta base
-- de datos y este backend, pero cada una es una empresa propia (socios y,
-- probablemente, NIT distintos), con su propia bodega, su propio consecutivo
-- de facturación y su propia habilitación DIAN.

create extension if not exists "pgcrypto";

create table empresa (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nit text,
  es_facturador_dian boolean not null default false,
  creado_en timestamptz not null default now()
);

create table usuario (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresa(id),
  nombre text not null,
  email text unique not null,
  password_hash text not null,
  rol text not null default 'operador', -- operador | admin
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create table tercero (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('cliente', 'proveedor', 'ambos')),
  nombre text not null,
  tipo_documento text, -- CC, NIT, CE...
  numero_documento text,
  email text,
  telefono text,
  creado_en timestamptz not null default now()
);

create table producto (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  nombre text not null,
  tipo text not null check (tipo in ('materia_prima', 'intermedio', 'terminado')),
  unidad_medida text not null, -- kg, un, lb...
  creado_en timestamptz not null default now(),
  unique (empresa_id, nombre)
);

create table bodega (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  nombre text not null,
  creado_en timestamptz not null default now()
);

create table existencia (
  bodega_id uuid not null references bodega(id),
  producto_id uuid not null references producto(id),
  cantidad numeric(14, 3) not null default 0,
  costo_promedio numeric(14, 2) not null default 0,
  actualizado_en timestamptz not null default now(),
  primary key (bodega_id, producto_id)
);

-- Tabla central: todo movimiento de inventario queda aquí.
create table movimiento_inventario (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in (
    'compra',
    'porcionado_entrada', 'porcionado_salida',
    'traslado_salida', 'traslado_entrada',
    'produccion_consumo', 'produccion_entrada',
    'venta'
  )),
  producto_id uuid not null references producto(id),
  bodega_id uuid not null references bodega(id),
  cantidad numeric(14, 3) not null,
  costo_unitario numeric(14, 2) not null,
  referencia_tipo text, -- compra | traslado | orden_produccion | factura_venta
  referencia_id uuid,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create index on movimiento_inventario (producto_id, bodega_id);
create index on movimiento_inventario (referencia_tipo, referencia_id);

-- Traslado entre empresas (Agrocarnes -> Restaurante, Agrocarnes -> D'Monsa).
-- factura_venta_id queda nulo si es traslado interno sin factura; si el
-- contador pide facturar entre compañías, se llena y el traslado también
-- queda como una venta normal.
create table traslado (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references producto(id),
  bodega_origen_id uuid not null references bodega(id),
  bodega_destino_id uuid not null references bodega(id),
  cantidad numeric(14, 3) not null,
  costo_unitario numeric(14, 2) not null,
  es_venta_intercompania boolean not null default false,
  factura_venta_id uuid,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);

create table receta (
  id uuid primary key default gen_random_uuid(),
  producto_terminado_id uuid not null references producto(id),
  producto_insumo_id uuid not null references producto(id),
  cantidad_por_unidad numeric(14, 4) not null
);

create table orden_produccion (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  producto_terminado_id uuid not null references producto(id),
  cantidad_producida numeric(14, 3) not null,
  bodega_id uuid not null references bodega(id),
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);

create table compra (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  proveedor_id uuid not null references tercero(id),
  numero_factura_proveedor text,
  fecha date not null default current_date,
  total numeric(14, 2) not null default 0,
  creado_en timestamptz not null default now()
);

create table compra_item (
  id uuid primary key default gen_random_uuid(),
  compra_id uuid not null references compra(id) on delete cascade,
  producto_id uuid not null references producto(id),
  bodega_id uuid not null references bodega(id),
  cantidad numeric(14, 3) not null,
  costo_unitario numeric(14, 2) not null
);

create table factura_venta (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  cliente_id uuid references tercero(id),
  consecutivo text, -- se asigna con el prefijo/rango autorizado por la DIAN de esa empresa
  fecha timestamptz not null default now(),
  total numeric(14, 2) not null default 0,
  estado_dian text not null default 'pendiente', -- pendiente | aceptada | rechazada | contingencia
  cufe text,
  xml_url text,
  pdf_url text,
  creado_en timestamptz not null default now()
);

create table factura_venta_item (
  id uuid primary key default gen_random_uuid(),
  factura_venta_id uuid not null references factura_venta(id) on delete cascade,
  producto_id uuid not null references producto(id),
  cantidad numeric(14, 3) not null,
  precio_unitario numeric(14, 2) not null
);

-- Datos base: las tres empresas.
insert into empresa (nombre, es_facturador_dian) values
  ('Agrocarnes', true),
  ('Restaurante', true),
  ('D''Monsa Alimentos', false);
