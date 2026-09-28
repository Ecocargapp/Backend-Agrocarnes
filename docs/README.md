# Documentación del sistema Agrocarnes

Documentación técnica y funcional del software **Agrocarnes**, desarrollado a
la medida para el control de inventario, compras, producción, ventas y
facturación electrónica de tres empresas relacionadas: **Agrocarnes**
(punto de venta de carnes), el **Restaurante** y **D'Monsa Alimentos**
(planta de alimentos procesados).

Esta documentación se mantiene **dentro del repositorio de código**
(`Backend-Agrocarnes/docs/`), de forma que cada versión del software tiene su
documentación correspondiente y el historial completo de cambios queda
registrado con fecha, autor y contenido en el control de versiones (Git).

| Documento | Contenido |
| --- | --- |
| [01 · Descripción general](01-descripcion-general.md) | Qué hace el sistema, empresas, alcance, responsables |
| [02 · Arquitectura](02-arquitectura.md) | Componentes, tecnologías, infraestructura, dominios |
| [03 · Modelo de datos](03-modelo-datos.md) | Tablas, campos, relaciones e integridad |
| [04 · Procesos de negocio](04-procesos.md) | Compras, porcionado/producción, traslados, ventas: paso a paso y efecto contable |
| [05 · Facturación electrónica](05-facturacion-electronica.md) | Integración con Arco ERP, estados, trazabilidad, CUFE |
| [06 · Seguridad y control de acceso](06-seguridad.md) | Usuarios, roles, autenticación, integridad de registros |
| [07 · Operación, respaldos y continuidad](07-operacion.md) | Despliegue, respaldos, recuperación, monitoreo |
| [08 · Bitácora de cambios](../CHANGELOG.md) | Historial de versiones del software |

## Cómo generar el PDF

```bash
bash docs/generar-pdf.sh      # produce docs/Documentacion-Agrocarnes.pdf
```

## Regla de mantenimiento

Todo cambio funcional al software se entrega en un mismo commit con:

1. El código.
2. La actualización del documento afectado en `docs/`.
3. Una entrada en `CHANGELOG.md` (fecha, versión, qué cambió y por qué).

Los repositorios son públicos en GitHub (`Ecocargapp/Backend-Agrocarnes` y
`Ecocargapp/Frontend-Agrocarnes`), por lo que el historial completo es
verificable por cualquier tercero: `git log`, `git show <commit>`.
