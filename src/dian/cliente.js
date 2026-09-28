// Punto único de integración con la DIAN. Hoy es un placeholder: guarda la
// factura como "pendiente" y no llama a nadie. Cuando elijan un proveedor
// tecnológico (ver el documento de diseño: Facturalatam, MATIAS API, Alegra,
// Siigo...), esta es la única función que hay que llenar — el resto del
// backend no necesita cambiar.
//
// Pasos reales que va a hacer esta función una vez haya proveedor elegido:
//   1. Armar el JSON de la factura en el formato que pida el proveedor
//      (emisor = la empresa dueña de la factura, con su propio NIT/resolución).
//   2. POST a su API con las credenciales de esa empresa.
//   3. Guardar cufe, xml_url, pdf_url y estado_dian con la respuesta.
//   4. Si falla, dejar estado_dian = 'pendiente' para que un job de
//      reintentos (ver README) lo vuelva a intentar; nunca fallar la venta
//      ya hecha.

import { pool } from '../db/pool.js';

export async function enviarFacturaADian(facturaVentaId) {
  // TODO: reemplazar por la llamada real al proveedor tecnológico elegido.
  await pool.query(
    `update factura_venta set estado_dian = 'pendiente' where id = $1`,
    [facturaVentaId]
  );
}
