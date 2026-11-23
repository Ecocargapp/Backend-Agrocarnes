-- Ajustes de inventario (toma física / cuadre): se registra la cantidad
-- contada de cada producto en una bodega; la diferencia contra el sistema
-- entra (sobrante) o sale (faltante) del inventario al costo promedio y se
-- contabiliza según el motivo de cada línea.
create table if not exists ajuste_inventario (
  id uuid primary key default gen_random_uuid(),
  numero integer not null unique,  -- consecutivo sin huecos (se asigna al guardar)
  empresa_id uuid not null references empresa(id),
  bodega_id uuid not null references bodega(id),
  fecha date not null default ((now() at time zone 'America/Bogota')::date),
  observacion text,
  estado text not null default 'vigente' check (estado in ('vigente', 'anulado')),
  anulado_en timestamptz,
  anulado_por uuid references usuario(id),
  motivo_anulacion text,
  creado_por uuid references usuario(id),
  creado_en timestamptz not null default now()
);
create index if not exists ajuste_inventario_bodega_idx on ajuste_inventario (bodega_id, fecha);

create table if not exists ajuste_inventario_item (
  id uuid primary key default gen_random_uuid(),
  ajuste_id uuid not null references ajuste_inventario(id) on delete cascade,
  producto_id uuid not null references producto(id),
  cantidad_sistema numeric(14, 3) not null,
  cantidad_contada numeric(14, 3) not null check (cantidad_contada >= 0),
  diferencia numeric(14, 3) not null,          -- contada - sistema (+ sobrante, − faltante)
  costo_unitario numeric(14, 2) not null default 0,
  -- merma (costo de ventas) | perdida (daño, vencido, robo) | consumo (consumo interno u obsequio)
  -- | conteo (diferencia de conteo/registro) ; los sobrantes van siempre a 'sobrante'
  motivo text not null check (motivo in ('merma', 'perdida', 'consumo', 'conteo', 'sobrante', 'sin_diferencia'))
);
create index if not exists ajuste_inventario_item_ajuste_idx on ajuste_inventario_item (ajuste_id);

alter table movimiento_inventario drop constraint if exists movimiento_inventario_tipo_check;
alter table movimiento_inventario add constraint movimiento_inventario_tipo_check check (tipo in (
  'compra',
  'porcionado_entrada', 'porcionado_salida',
  'traslado_salida', 'traslado_entrada',
  'produccion_consumo', 'produccion_entrada',
  'venta',
  'devolucion_venta', 'anulacion_venta',
  'anulacion_entrada',
  'anulacion_salida',
  'ajuste_entrada',  -- sobrante encontrado en la toma física
  'ajuste_salida'    -- faltante (merma, pérdida, consumo interno, diferencia de conteo)
));
