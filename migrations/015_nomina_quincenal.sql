-- Agrocarnes paga la nómina por quincenas: es el periodo por defecto de los
-- trabajadores (ante la DIAN se reporta un documento mensual que suma las
-- dos quincenas).
alter table empleado alter column periodo_pago set default '4';
update empleado set periodo_pago = '4' where periodo_pago = '5';
