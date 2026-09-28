# 05 · Facturación electrónica

## Modelo de operación

| Rol | Quién | Qué hace |
| --- | --- | --- |
| Sistema de ventas e inventario | Agrocarnes (este software) | Registra la venta, descuenta inventario, entrega a Arco los datos de la factura, recibe y guarda número oficial y CUFE |
| Proveedor tecnológico / software de facturación | Arco ERP (arco365.com) | Numera con la resolución DIAN de la empresa, genera el XML UBL, firma digitalmente, transmite a la DIAN, publica la representación gráfica y devuelve el CUFE |
| Obligado a facturar | Cada empresa (Agrocarnes, Restaurante) con su NIT, su resolución y su cuenta de Arco | Responsable ante la DIAN |

Este software **no genera XML, no firma y no se comunica con los servicios
de la DIAN**. Toda factura electrónica existe primero en Arco, que es quien
la reporta. Agrocarnes conserva copia de los datos comerciales (cliente,
ítems, valores), el identificador de Arco, el número oficial y el CUFE, lo
que permite cruzar en cualquier momento las ventas del sistema contra las
facturas emitidas en Arco y reportadas a la DIAN.

## Flujo detallado

```
Venta registrada (estado_dian = pendiente)
   │
   ▼  enviarFacturaADian()   ── inmediato tras la venta y reintentos cada 2 min
   ├─ 1. Login en Arco (token OAuth, se renueva automáticamente)
   ├─ 2. Cliente: ClienteId mapeado · o consumidor final (cliente_default_id)
   │       · o alta automática en Arco (Tercero/Insert + Cliente/Insert)
   ├─ 3. Ítems: cada producto debe tener arco_producto_id;
   │       precio → valor base (si el precio incluye impuesto, se divide por 1 + %)
   ├─ 4. POST Factura/Insert  → { FacturaId }        estado = enviada
   ▼
 sincronizarEstado()  ── GET Factura/Get/{FacturaId}
   ├─ FacturaId2 (prefijo+número oficial) → consecutivo
   ├─ FacturaCUFE presente               → estado = aceptada, se guarda cufe, url, fecha DIAN
   └─ FacturaMsgFE con error             → estado = rechazada, se guarda el mensaje
```

Errores técnicos (red, credenciales, Arco caído) dejan la factura en estado
`error` con el mensaje en `dian_mensaje`; el job la reintenta hasta 12 veces.
Un producto sin código Arco también queda en `error` y se reintenta solo en
cuanto se asigna el código. Nada de esto impide que la venta y el descuento
de inventario ya estén registrados.

## Estados de una factura (`estado_dian`)

| Estado | Significado | Acción |
| --- | --- | --- |
| pendiente | Registrada, aún no enviada | Automática |
| sin_configurar | La empresa no tiene cuenta de Arco configurada | Configurar y reintentar |
| enviada | Creada en Arco, esperando CUFE | Automática (consulta cada 5 min) |
| aceptada | CUFE recibido | Ninguna |
| error | Falló el envío por causa técnica o de datos | Se reintenta sola; el mensaje indica la causa |
| rechazada | Arco/DIAN la rechazó o se agotaron los reintentos | Revisar el mensaje; corregir y reintentar manualmente |

## Datos enviados a Arco por factura

| Campo Arco | Origen en Agrocarnes |
| --- | --- |
| DocumentoId, FacturaResolucionTipo | Configuración de la empresa (tipo de documento / resolución en Arco) |
| FacturaFecha | Fecha del día de emisión (zona America/Bogota) |
| ClienteId | Cliente mapeado o consumidor final |
| FacturaBodegaId, FacturaSucursalId, VendedorId, FacturaTipoPago | Configuración de la empresa |
| FacturaOrdenCliente | Consecutivo interno de Agrocarnes (para cruce) |
| FacturaOrdenInterna | UUID de la factura en Agrocarnes (para cruce) |
| Detalle[].ProductoId | `producto.arco_producto_id` |
| Detalle[].FacturaDetalleCantidad | Cantidad vendida |
| Detalle[].FacturaDetalleVrUnitario | Precio unitario **base** (sin impuesto) |

Los impuestos (IVA, impoconsumo) los liquida Arco según la configuración
tributaria de cada producto en Arco. En Agrocarnes, `impuesto_pct` solo se
usa para convertir el precio de venta (que incluye impuesto) a valor base.

## Datos recibidos de Arco y conservados

`arco_factura_id` (id interno de Arco), `consecutivo` (número oficial, ej.
`AGC1234`), `cufe`, `xml_url`/`pdf_url` (representación gráfica publicada
por Arco), `dian_fecha`, `dian_mensaje`.

## Configuración por empresa (`empresa.arco_config`)

Se administra en la pantalla **Configuración** (solo rol admin) e incluye:
host de Arco, nombre de empresa en Arco, usuario, contraseña (se guarda en
la base de datos, nunca se devuelve al navegador), DocumentoId,
tipo de resolución, SucursalId, BodegaId, ClienteId de consumidor final,
VendedorId, tipo de pago, ciudad DANE por defecto para clientes nuevos y si
los precios incluyen impuesto. El botón *Probar conexión* valida las
credenciales y muestra los catálogos de Arco (sucursales, bodegas,
documentos en uso) para diligenciar los parámetros sin error.

## Referencia de la API de Arco utilizada

Documentación oficial: https://documenter.getpostman.com/view/289978/UzJFweL6

| Endpoint | Uso |
| --- | --- |
| POST Security/Login | Obtener token |
| POST Factura/Insert | Crear la factura de venta |
| GET Factura/Get/{id} | Consultar número oficial, CUFE, estado FE |
| GET Factura/List | Prueba de conexión (documentos en uso) |
| GET Cliente/List, POST Tercero/Insert, POST Cliente/Insert | Buscar o crear el adquiriente |
| GET Sucursal/List, GET Bodega/List | Prueba de conexión |

Previstos (no implementados aún): POST NotaCredito/Insert (devoluciones y
anulaciones), POST Factura/Anula.

## Cruce para auditoría

Para verificar que toda venta del sistema tiene su factura electrónica:

```sql
select consecutivo, fecha, total, estado_dian, cufe, arco_factura_id
from factura_venta
where empresa_id = '<empresa>'
  and fecha between '<desde>' and '<hasta>'
order by fecha;
```

Toda fila debería estar en `aceptada` con `cufe` no nulo. Las que no lo
estén tienen en `dian_mensaje` la causa y son las que requieren gestión.
