-- Campos completos del tercero, iguales a la plantilla de importación de
-- terceros del software contable (Template-7580.xlsx).
alter table tercero add column if not exists tipo_persona text;            -- natural | juridica
alter table tercero add column if not exists primer_nombre text;
alter table tercero add column if not exists segundo_nombre text;
alter table tercero add column if not exists primer_apellido text;
alter table tercero add column if not exists segundo_apellido text;
alter table tercero add column if not exists razon_social text;
alter table tercero add column if not exists nombre_comercial text;
alter table tercero add column if not exists autorretenedor_renta boolean not null default false;
alter table tercero add column if not exists regimen_renta text;           -- código de la plantilla (4, 6, 10, 3...)
alter table tercero add column if not exists limite_rete_renta_facturar text not null default 'legal'; -- legal | cualquier
alter table tercero add column if not exists limite_rete_renta_comprar text not null default 'legal';
alter table tercero add column if not exists regimen_iva text;             -- 1, 2, 3, 4
alter table tercero add column if not exists tarifa_rete_iva numeric(6, 2) not null default 0; -- en %
alter table tercero add column if not exists regimen_ica text;
alter table tercero add column if not exists cuenta_bancaria text;
alter table tercero add column if not exists tipo_cuenta text;             -- 27 corriente | 37 ahorros
alter table tercero add column if not exists cod_banco text;
alter table tercero add column if not exists limite_rete_iva_facturar text not null default 'legal';
alter table tercero add column if not exists id_exterior text;
alter table tercero add column if not exists activo boolean not null default true;
alter table tercero add column if not exists codigo_pais text not null default '169';

update tercero set tipo_persona = case when upper(coalesce(tipo_documento, '')) = 'NIT' then 'juridica' else 'natural' end
where tipo_persona is null;
update tercero set razon_social = nombre where tipo_persona = 'juridica' and razon_social is null;
