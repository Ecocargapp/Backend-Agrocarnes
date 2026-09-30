-- Precio de venta sugerido, productos que no manejan inventario (platos del
-- restaurante) y tipo de impuesto (IVA o impuesto nacional al consumo, INC).

alter table producto add column if not exists precio_venta numeric(14, 2);
alter table producto add column if not exists maneja_inventario boolean not null default true;
alter table producto add column if not exists tipo_impuesto text not null default 'IVA';

alter table producto drop constraint if exists producto_tipo_impuesto_check;
alter table producto add constraint producto_tipo_impuesto_check check (tipo_impuesto in ('IVA', 'INC'));
