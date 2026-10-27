-- Vendedores: quién hizo la venta, para el informe de ventas por vendedor y
-- el cálculo de comisiones. Un vendedor puede ser de una empresa (centro de
-- costo) o de todas (empresa_id vacío). Nunca se borra: se desactiva, para no
-- perder el histórico de sus facturas.
create table if not exists vendedor (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  documento text,
  telefono text,
  empresa_id uuid references empresa(id),
  comision_pct numeric(5, 2) not null default 0 check (comision_pct >= 0 and comision_pct <= 100),
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);
create unique index if not exists vendedor_documento_unico on vendedor (documento) where documento is not null and documento <> '';

alter table factura_venta add column if not exists vendedor_id uuid references vendedor(id);
create index if not exists factura_venta_vendedor_idx on factura_venta (vendedor_id, fecha);
