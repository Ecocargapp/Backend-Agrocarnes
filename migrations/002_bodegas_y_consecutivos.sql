-- Bodega principal por empresa (si no existe) y detalle en órdenes de producción.

insert into bodega (empresa_id, nombre)
select e.id, 'Principal'
from empresa e
where not exists (select 1 from bodega b where b.empresa_id = e.id);

-- Guardamos el costo unitario del terminado en la orden, para reportes.
alter table orden_produccion add column if not exists costo_unitario numeric(14, 2);

-- Un producto no debería tener dos filas de receta para el mismo insumo.
create unique index if not exists receta_unica
  on receta (producto_terminado_id, producto_insumo_id);

-- Consecutivo simple por empresa para las facturas de venta (hasta que cada
-- empresa tenga su prefijo/rango DIAN).
alter table empresa add column if not exists prefijo_factura text;
alter table empresa add column if not exists ultimo_consecutivo integer not null default 0;
update empresa set prefijo_factura = 'AGC' where nombre = 'Agrocarnes' and prefijo_factura is null;
update empresa set prefijo_factura = 'RST' where nombre = 'Restaurante' and prefijo_factura is null;
update empresa set prefijo_factura = 'DMS' where nombre like 'D%Monsa%' and prefijo_factura is null;
