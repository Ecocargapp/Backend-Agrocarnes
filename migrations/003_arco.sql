-- Integración con Arco ERP (facturación electrónica).

-- Configuración de Arco por empresa (cada NIT tiene su propia cuenta Arco).
alter table empresa add column if not exists arco_config jsonb;
--   arco_config = {
--     host: "miempresa.arco365.com", company: "miempresa", user: "...", password: "...",
--     documento_id: 15, resolucion_tipo: "04", sucursal_id: "1", bodega_id: "01",
--     cliente_default_id: "101",   -- cliente "consumidor final / cuantías menores" en Arco
--     vendedor_id: "0", tipo_pago: "E", ciudad_id: "05001", precios_incluyen_impuesto: true
--   }

-- Mapeo de catálogos hacia Arco.
alter table producto add column if not exists arco_producto_id text;
alter table producto add column if not exists impuesto_pct numeric(5, 2) not null default 0; -- IVA o impoconsumo incluido en el precio de venta
alter table tercero add column if not exists arco_tercero_id text;
alter table tercero add column if not exists arco_cliente_id text;
alter table tercero add column if not exists ciudad_id text; -- código DANE (ej. 05001 Medellín)
alter table tercero add column if not exists direccion text;

-- Trazabilidad DIAN en la factura.
alter table factura_venta add column if not exists arco_factura_id text;
alter table factura_venta add column if not exists dian_mensaje text;
alter table factura_venta add column if not exists dian_intentos integer not null default 0;
alter table factura_venta add column if not exists dian_ultimo_intento timestamptz;
alter table factura_venta add column if not exists dian_fecha timestamptz;

-- Estados: pendiente (no enviada aún) · sin_configurar (empresa sin Arco) · enviada (en Arco,
-- esperando CUFE) · aceptada (CUFE recibido) · rechazada (Arco/DIAN devolvió error) · error (fallo técnico, se reintenta)
create index if not exists factura_venta_estado_dian on factura_venta (estado_dian);
