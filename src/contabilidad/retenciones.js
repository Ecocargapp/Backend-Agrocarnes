// Cálculo de retenciones que PRACTICAMOS al comprar (Agropollo es agente
// retenedor de renta por ser persona jurídica). Tabla del Decreto 572 de 2025
// (vigente desde el 1/07/2026) en la tabla concepto_retencion.
//
// Reglas:
//  - Retefuente: solo si la base (sin IVA) ≥ base mínima en UVT del concepto.
//    No se practica si el proveedor es autorretenedor o del régimen simple (10).
//    Honorarios: 11% persona jurídica, 10% persona natural; demás: tarifa de declarante.
//  - ReteIVA: 15% del IVA, solo si la empresa está configurada como agente de
//    retención de IVA (grandes contribuyentes y designados) y el proveedor es
//    responsable de IVA.
//  - ReteICA: base × tarifa por mil del municipio (configuración de la empresa).
// Todo se puede corregir a mano en el documento.
import { pool } from '../db/pool.js';

const r0 = (n) => Math.round(Number(n || 0)); // la DIAN redondea retenciones al peso

export async function calcularRetenciones({ empresa_id, proveedor_id, concepto, base, iva }) {
  const [{ rows: e }, { rows: t }, { rows: c }] = await Promise.all([
    pool.query('select config_tributaria from empresa where id = $1', [empresa_id]),
    pool.query('select tipo_persona, autorretenedor_renta, regimen_renta, regimen_iva from tercero where id = $1', [proveedor_id]),
    pool.query('select * from concepto_retencion where codigo = $1', [concepto || 'ninguna']),
  ]);
  const cfg = e[0]?.config_tributaria || { uvt: 52374 };
  const prov = t[0] || {};
  const con = c[0];
  const res = { retefuente: 0, reteiva: 0, reteica: 0, tarifa: 0, base_minima: 0, motivo: null };
  if (!con || con.codigo === 'ninguna') return { ...res, motivo: 'Sin concepto de retención' };
  res.base_minima = r0(Number(con.base_uvt) * Number(cfg.uvt || 52374));
  if (Number(base) < res.base_minima) {
    res.motivo = `La base no llega al mínimo de ${con.base_uvt} UVT ($${res.base_minima.toLocaleString('es-CO')})`;
  } else if (prov.autorretenedor_renta) {
    res.motivo = 'El proveedor es autorretenedor';
  } else if (prov.regimen_renta === '10') {
    res.motivo = 'El proveedor es del régimen simple';
  } else {
    res.tarifa = con.codigo === 'honorarios' && prov.tipo_persona !== 'juridica' ? Number(con.tarifa_no_declarante) : Number(con.tarifa_declarante);
    res.retefuente = r0(Number(base) * res.tarifa / 100);
  }
  if (cfg.agente_reteiva && Number(iva) > 0 && prov.regimen_iva === '3') res.reteiva = r0(Number(iva) * 0.15);
  if (Number(cfg.reteica_por_mil) > 0 && Number(base) >= res.base_minima) res.reteica = r0(Number(base) * Number(cfg.reteica_por_mil) / 1000);
  return res;
}
