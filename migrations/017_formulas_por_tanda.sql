-- Fórmulas por tanda: la fórmula se escribe "para X kg (o unidades) de
-- producto uso estos insumos", como se trabaja en la planta. Se sigue
-- guardando la cantidad por unidad (cantidad / base) para producir.
create table if not exists formula (
  producto_terminado_id uuid primary key references producto(id) on delete cascade,
  cantidad_base numeric(14, 3) not null default 1 check (cantidad_base > 0),
  notas text,
  actualizado_en timestamptz not null default now()
);

alter table receta add column if not exists cantidad numeric(14, 4);
alter table receta alter column cantidad_por_unidad type numeric(18, 8);
update receta set cantidad = cantidad_por_unidad where cantidad is null;
insert into formula (producto_terminado_id, cantidad_base)
select distinct producto_terminado_id, 1 from receta on conflict do nothing;

-- Producción: lote, notas y fecha de la producción.
alter table orden_produccion add column if not exists lote text;
alter table orden_produccion add column if not exists notas text;
alter table orden_produccion add column if not exists fecha date not null default current_date;
