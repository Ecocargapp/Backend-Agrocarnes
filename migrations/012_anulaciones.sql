-- Anulación de documentos: compras, gastos, recibos de caja, comprobantes de
-- egreso, traslados y órdenes de producción. Un documento anulado se conserva
-- (trazabilidad) pero no cuenta en cartera, inventario ni contabilidad.
alter table compra           add column if not exists estado text not null default 'vigente';
alter table compra           add column if not exists anulado_en timestamptz;
alter table compra           add column if not exists anulado_por uuid references usuario(id);
alter table compra           add column if not exists motivo_anulacion text;
alter table recibo_caja      add column if not exists estado text not null default 'vigente';
alter table recibo_caja      add column if not exists anulado_en timestamptz;
alter table recibo_caja      add column if not exists anulado_por uuid references usuario(id);
alter table recibo_caja      add column if not exists motivo_anulacion text;
alter table pago_proveedor   add column if not exists estado text not null default 'vigente';
alter table pago_proveedor   add column if not exists anulado_en timestamptz;
alter table pago_proveedor   add column if not exists anulado_por uuid references usuario(id);
alter table pago_proveedor   add column if not exists motivo_anulacion text;
alter table traslado         add column if not exists estado text not null default 'vigente';
alter table traslado         add column if not exists anulado_en timestamptz;
alter table traslado         add column if not exists anulado_por uuid references usuario(id);
alter table traslado         add column if not exists motivo_anulacion text;
alter table orden_produccion add column if not exists estado text not null default 'vigente';
alter table orden_produccion add column if not exists anulado_en timestamptz;
alter table orden_produccion add column if not exists anulado_por uuid references usuario(id);
alter table orden_produccion add column if not exists motivo_anulacion text;

-- Movimientos de inventario que reversan un documento anulado.
alter table movimiento_inventario drop constraint if exists movimiento_inventario_tipo_check;
alter table movimiento_inventario add constraint movimiento_inventario_tipo_check check (tipo in (
  'compra',
  'porcionado_entrada', 'porcionado_salida',
  'traslado_salida', 'traslado_entrada',
  'produccion_consumo', 'produccion_entrada',
  'venta',
  'devolucion_venta', 'anulacion_venta',
  'anulacion_entrada',  -- sale lo que había entrado con un documento anulado
  'anulacion_salida'    -- vuelve a entrar lo que había salido con un documento anulado
));

-- Bitácora de anulaciones (quién, cuándo, por qué, qué se reversó).
create table if not exists anulacion (
  id uuid primary key default gen_random_uuid(),
  documento text not null,          -- factura_venta | compra | gasto | recibo_caja | pago_proveedor | traslado | orden_produccion
  documento_id uuid not null,
  empresa_id uuid references empresa(id),
  descripcion text,
  motivo text not null,
  detalle jsonb,
  usuario_id uuid references usuario(id),
  creado_en timestamptz not null default now()
);
