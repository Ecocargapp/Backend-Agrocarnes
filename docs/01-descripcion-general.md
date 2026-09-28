# 01 · Descripción general del sistema

## Identificación

| | |
| --- | --- |
| Nombre del software | Agrocarnes |
| Tipo | Sistema de información propio (desarrollo a la medida) para inventario, compras, producción, ventas y facturación electrónica |
| Propietario | Jonatan Botero (desarrollo y administración) |
| Empresas usuarias | Agrocarnes · Restaurante · D'Monsa Alimentos |
| Inicio de desarrollo | 27 de septiembre de 2026 |
| Puesta en producción | 28 de septiembre de 2026 |
| Repositorios | github.com/Ecocargapp/Backend-Agrocarnes · github.com/Ecocargapp/Frontend-Agrocarnes |
| URL de la aplicación | https://agrocarnes.agrofranpabel.com |
| URL de la API | https://api-agrocarnes.agrofranpabel.com |

## Propósito

El sistema controla el flujo físico y de costos de la carne y demás insumos
entre tres empresas relacionadas pero jurídicamente independientes, y emite
las facturas de venta al cliente final a través de un proveedor tecnológico
autorizado (Arco ERP), evitando la doble facturación de un mismo producto.

## Empresas y roles en el flujo

| Empresa | Rol en el flujo | Relación |
| --- | --- | --- |
| Agro Franpabel | Proveedor externo: vende cerdo despostado a Agrocarnes y a D'Monsa con factura | Empresa relacionada (control de granjas en su propio sistema, AgroSoft) |
| Agrocarnes | Compra la canal, la porciona en cortes, vende al público en mostrador y traslada inventario al Restaurante y a D'Monsa | Sociedad con un socio |
| Restaurante | Recibe cortes porcionados de Agrocarnes por traslado, los transforma en platos y factura al cliente final | Sociedad con otro socio |
| D'Monsa Alimentos | Recibe carne para embutidos de Agrocarnes y otros insumos comprados; produce salchicha, jamón, panzerotis, empanadas y palitos de queso | 100 % del propietario |

Cada empresa es una **entidad independiente dentro del sistema**: tiene sus
propias bodegas, sus propios productos, su propio consecutivo de facturación
y su propia cuenta ante el proveedor de facturación electrónica. Comparten
únicamente la base de datos y el servidor, por economía.

## Alcance funcional (versión actual)

| Módulo | Función |
| --- | --- |
| Inventario | Existencias por bodega con cantidad y costo promedio ponderado; kardex por producto; catálogo de productos |
| Compras | Registro de la factura del proveedor; entrada de inventario al costo facturado |
| Traslados | Movimiento de producto entre bodegas de distintas empresas, al costo, con salida y entrada registradas |
| Formulación y producción | Fórmulas (recetas) por producto; órdenes de producción que consumen insumos y entran el producto terminado con su costo calculado |
| Ventas | Factura de venta al cliente final con descuento de inventario; envío a facturación electrónica |
| Facturación electrónica | Emisión a través de Arco ERP (proveedor tecnológico); recepción y almacenamiento del CUFE |
| Configuración | Parámetros de conexión a Arco por empresa (solo administrador) |

## Fuera de alcance (a la fecha)

- Contabilidad de partida doble, nómina, cartera y tesorería: se llevan en el
  ERP contable de cada empresa (Arco) y por el contador.
- Notas crédito y anulación de facturas electrónicas: previstas; se documentarán
  en la bitácora cuando se implementen.
- Facturación de D'Monsa Alimentos: hoy D'Monsa recibe inventario y produce;
  sus ventas se facturarán cuando tenga su propia cuenta de Arco.

## Relación con el proveedor tecnológico

El sistema **no firma ni transmite directamente** documentos a la DIAN. La
factura electrónica la genera, numera, firma y transmite **Arco ERP**
(arco365.com), proveedor tecnológico con el que cada empresa tiene su
contrato y su resolución de facturación. Agrocarnes actúa como sistema de
ventas e inventario que le entrega a Arco la información de cada venta y
recibe de vuelta el número de factura y el CUFE. El detalle está en el
documento 05.
