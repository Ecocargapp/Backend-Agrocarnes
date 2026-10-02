-- Código legible del producto (ej. C3001, R1001, A0001). Es el que sale en la
-- columna "Código" de la factura electrónica en lugar del id interno.
alter table producto add column if not exists codigo text;
create unique index if not exists producto_codigo_empresa on producto (empresa_id, upper(codigo)) where codigo is not null;

-- Productos creados con el código al inicio del nombre ("C3001 Costilla de cerdo"):
-- se separa el código y se deja el nombre limpio.
update producto
set codigo = substring(nombre from '^([A-Za-z]\d{3,5})\s'),
    nombre = trim(substring(nombre from '^[A-Za-z]\d{3,5}\s+(.*)$'))
where codigo is null and nombre ~ '^[A-Za-z]\d{3,5}\s+\S';
