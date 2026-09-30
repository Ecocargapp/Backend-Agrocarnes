-- Venta interna: entre dos centros de costo de la misma razón social (ej.
-- Carnicería → Restaurante, ambos de Unión Avícola Agropollo). Mueve
-- inventario, precio y cartera, pero NO se envía a la DIAN: una empresa no
-- puede facturarse electrónicamente a su propio NIT.
alter table factura_venta add column if not exists venta_interna boolean not null default false;
