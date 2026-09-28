-- Integración con Factus (nuevo proveedor de facturación y nómina electrónica,
-- reemplaza a Arco). Se agrega en paralelo a Arco: cada empresa elige su
-- proveedor con `proveedor_dian`, así se puede probar Factus en una empresa
-- (o en sandbox) sin afectar a las que siguen facturando con Arco.

alter table empresa add column if not exists factus_config jsonb;
--   factus_config = {
--     base_url: "https://api-sandbox.factus.com.co",  -- sandbox o el de producción
--     client_id: "...", client_secret: "...", email: "...", password: "...",
--     numbering_range_id_factura: 389,       -- GET /v2/numbering-ranges (opcional si solo hay un rango activo)
--     numbering_range_id_nota_credito: 1776,
--     cliente_default: {                     -- "consumidor final" cuando la venta no tiene tercero
--       identification_document_code: "13", identification: "222222222", names: "Consumidor final",
--       legal_organization_code: "2", tribute_code: "ZZ", municipality_code: "05001"
--     }
--   }
alter table empresa add column if not exists proveedor_dian text not null default 'arco';
alter table empresa add constraint empresa_proveedor_dian_check check (proveedor_dian in ('arco', 'factus'));

-- Código de unidad de medida y de bien/servicio que exige Factus por ítem.
-- Si el producto no tiene código propio, se infiere de unidad_medida en código
-- (ver src/dian/facturas-factus.js); estandar_code por defecto "999" = No aplica.
alter table producto add column if not exists factus_unidad_medida_code text;
alter table producto add column if not exists factus_estandar_code text not null default '999';

-- Nota: factura_venta y nota_credito ya tienen (desde 003_arco.sql) las columnas
-- genéricas cufe, pdf_url, xml_url, dian_mensaje, dian_intentos, dian_ultimo_intento,
-- dian_fecha, y consecutivo — se reutilizan tal cual para Factus (el "number" que
-- devuelve Factus, ej. SETP990021506 o CRTE713, se guarda en consecutivo). El
-- reference_code que se envía a Factus es simplemente el id local de la factura o
-- nota (uuid), lo que hace el envío idempotente ante reintentos sin columnas nuevas.
