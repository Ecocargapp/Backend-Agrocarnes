-- Cajas, cuentas bancarias y tarjetas de crédito de cada empresa, y de cuál
-- sale (egresos) o a cuál entra (recibos) cada pago. Cada una tiene su propia
-- subcuenta contable para que el balance muestre el saldo por banco.

insert into cuenta (codigo, nombre, naturaleza, grupo) values
  ('110505', 'Caja general',                        'debito',  'activo_corriente'),
  ('2105',   'Obligaciones financieras (tarjetas)', 'credito', 'pasivo')
on conflict (codigo) do nothing;

create table if not exists cuenta_pago (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresa(id),
  tipo text not null check (tipo in ('caja', 'banco', 'tarjeta_credito')),
  nombre text not null,                 -- ej. "Bancolombia ahorros ···4321", "Caja restaurante"
  banco text,
  tipo_cuenta text,                     -- ahorros | corriente (bancos)
  numero text,
  cuenta_contable text not null references cuenta(codigo),
  activa boolean not null default true,
  creado_en timestamptz not null default now()
);

-- Caja general para cada empresa (la cuenta 110505).
insert into cuenta_pago (empresa_id, tipo, nombre, cuenta_contable)
select e.id, 'caja', 'Caja general', '110505' from empresa e
where not exists (select 1 from cuenta_pago c where c.empresa_id = e.id and c.tipo = 'caja');

alter table pago_proveedor add column if not exists cuenta_pago_id uuid references cuenta_pago(id);
alter table pago_proveedor add column if not exists referencia text;      -- # transacción, cheque, aprobación
alter table recibo_caja add column if not exists cuenta_pago_id uuid references cuenta_pago(id);
alter table recibo_caja add column if not exists referencia text;

-- Pagos y recibos anteriores en efectivo → caja general de su empresa.
update pago_proveedor p set cuenta_pago_id = c.id from cuenta_pago c
where p.cuenta_pago_id is null and p.medio_pago = 'efectivo' and c.empresa_id = p.empresa_id and c.tipo = 'caja';
update recibo_caja r set cuenta_pago_id = c.id from cuenta_pago c
where r.cuenta_pago_id is null and r.medio_pago = 'efectivo' and c.empresa_id = r.empresa_id and c.tipo = 'caja';
