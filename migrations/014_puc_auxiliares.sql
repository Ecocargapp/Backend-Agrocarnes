-- PUC con auxiliares de 8 dígitos (clase 1 · grupo 2 · cuenta 4 · subcuenta 6 · auxiliar 8).
-- Los asientos se registran en auxiliares de 8 dígitos (src/contabilidad/puc.js);
-- los niveles superiores se calculan sumando. Para pasar los asientos anteriores
-- al nuevo plan basta con "Reconstruir contabilidad".

-- Documento soporte del asiento (FE12, CE3, RC5, NE1…) para los libros.
alter table asiento add column if not exists documento text;
-- NIT de la línea cuando no es un tercero del sistema (trabajadores, consumidor final, la propia empresa).
alter table asiento_linea add column if not exists nit text;
alter table asiento_linea add column if not exists nit_nombre text;

-- La caja general pasa de la subcuenta 110505 a su auxiliar 11050501.
insert into cuenta (codigo, nombre, naturaleza, grupo) values ('11050501', 'CAJA GENERAL', 'debito', 'activo_corriente')
on conflict (codigo) do nothing;
update cuenta_pago set cuenta_contable = '11050501' where cuenta_contable = '110505';

-- Orden exacto de los movimientos de inventario (dentro de una misma transacción
-- now() es igual para todos); lo usa el recálculo de existencias.
alter table movimiento_inventario alter column creado_en set default clock_timestamp();
