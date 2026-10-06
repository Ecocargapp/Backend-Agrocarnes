# 07 · Nómina electrónica (Factus)

## Cómo funciona

1. **Trabajadores** (Nómina → Trabajadores): datos que exige la DIAN (documento,
   nombres, dirección y municipio DANE, contrato, tipo de trabajador, salario,
   fecha de ingreso/retiro, medio de pago y cuenta bancaria). Cada trabajador
   pertenece a una empresa / centro de costo.
2. **Liquidar** (Nómina → Liquidar nómina): se elige trabajador, mes (y quincena
   si se le paga quincenal), fecha de pago y cuenta de la que sale el dinero, y
   se digitan las novedades. La liquidación se ve en vivo antes de guardar.
3. Al guardar se crea el asiento contable y se envía a la DIAN por Factus
   (`POST v2/payrolls`). Queda el número (p. ej. NEF12), el CUNE y el PDF.
4. **Anular**: si ya fue aceptada, se emite la nota de ajuste de eliminación
   (`POST v2/adjustment-payrolls`) y se borra el asiento; después se puede
   volver a liquidar ese periodo.

## Reglas de liquidación (src/nomina/liquidar.js, src/nomina/parametros.js)

- SMMLV 2026 $1.750.905, auxilio de transporte $249.095 (decretos 1469 y 1470 de 2025), UVT $52.374.
- Sueldo = salario / 30 × días efectivamente laborados (descuenta vacaciones
  disfrutadas, licencias e incapacidades, que se pagan aparte).
- Auxilio de transporte hasta 2 SMMLV, proporcional a los días laborados.
- Horas: valor hora = salario / horas del mes (220 h hasta el 14-jul-2026,
  210 h desde el 15-jul-2026, Ley 2101). Extra diurna 25%, extra nocturna 75%,
  recargo nocturno 35%, dominical/festivo 80% (90% desde 1-jul-2026, Ley 2466).
- Incapacidad común: 2/3 del salario diario (mínimo 1 SMMLV diario); laboral y profesional 100%.
- Prima = (salario + auxilio) × días del semestre / 360. Cesantías = (salario +
  auxilio) × días del año / 360; intereses 12% anual proporcional.
- Salud 4% y pensión 4% sobre el IBC (devengados salariales; mínimo 1 SMMLV
  proporcional, máximo 25). Fondo de solidaridad pensional desde 4 SMMLV.
- Retención en la fuente procedimiento 1 (art. 383 E.T.) con renta exenta del
  25% (tope 790 UVT/año) y límite del 40%; se puede digitar a mano.
- Aportes del empleador para la contabilidad: pensión 12%, ARL según clase,
  caja 4%; salud 8,5%, SENA e ICBF solo si el trabajador gana 10 SMMLV o más
  (exoneración art. 114-1 E.T.).

## Contabilidad

Dr 5105xx (sueldos, horas extra, auxilio de transporte, vacaciones, prima,
cesantías, intereses, incapacidades, licencias, bonificaciones, aportes) ·
Cr 237005 salud, 238030 pensión y FSP, 236505 retención por salarios, 237030
libranzas, 1330 anticipos, 237006 ARL, 237010 parafiscales, y la caja o banco
por el neto pagado. La retención por salarios aparece en Informes → Retenciones
(formulario 350).

## Cuenta de Factus

Nómina → Cuenta DIAN: cada empresa puede usar credenciales propias de nómina
(el sandbox de habilitación), la misma cuenta de facturación, o la cuenta de
nómina de otra empresa de la misma razón social (Restaurante → Agrocarnes).
"Probar conexión" lista los rangos de nómina y de notas de ajuste.

## Habilitación (sandbox)

Factus exige mínimo 20 nóminas con datos distintos (salarios, trabajadores,
prima, cesantías, vacaciones, licencias, horas extra y recargos, meses
distintos) y después las notas de ajuste. El set está en
`src/nomina/casos-habilitacion.js` y se envía, sin guardar nada en la base de
datos, con:

    node scripts/habilitacion-nomina.js "Agrocarnes"              # las 20 nóminas
    node scripts/habilitacion-nomina.js "Agrocarnes" --solo=3,5   # reintentar casos
    node scripts/habilitacion-nomina.js "Agrocarnes" --ajuste=NEF5 # fase 2: nota de ajuste
    node scripts/habilitacion-nomina.js "Agrocarnes" --ver        # ver el JSON del caso 1

Solo corre contra el sandbox (salvo `--produccion`).

## Pendientes conocidos

- Provisión mensual de prima, cesantías y vacaciones (hoy se causan cuando se pagan).
- Planilla PILA y nota de ajuste de reemplazo (Factus solo documenta la de eliminación).
- Salario variable en la base de vacaciones y prestaciones.
