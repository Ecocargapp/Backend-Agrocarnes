import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { requireAuth, requireRole } from './middleware/auth.js';
import { iniciarJobDian } from './dian/cliente.js';
import { iniciarJobNotasCredito } from './dian/notas.js';
import { router as authRouter } from './routes/auth.js';
import { router as empresasRouter } from './routes/empresas.js';
import { router as productosRouter } from './routes/productos.js';
import { router as inventarioRouter } from './routes/inventario.js';
import { router as comprasRouter } from './routes/compras.js';
import { router as trasladosRouter } from './routes/traslados.js';
import { router as produccionRouter } from './routes/produccion.js';
import { router as ventasRouter } from './routes/ventas.js';
import { router as bodegasRouter } from './routes/bodegas.js';
import { router as tercerosRouter } from './routes/terceros.js';
import { router as recetasRouter } from './routes/recetas.js';
import { router as carteraRouter } from './routes/cartera.js';
import { router as notasCreditoRouter } from './routes/notas-credito.js';
import { router as gastosRouter } from './routes/gastos.js';
import { router as informesRouter } from './routes/informes.js';
import { router as cuentasPagoRouter } from './routes/cuentas-pago.js';
import { router as nominaRouter } from './routes/nomina.js';
import { router as usuariosRouter } from './routes/usuarios.js';

const app = express();
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors({
  origin: !corsOrigin || corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
}));
app.use(express.json({ limit: '1mb' })); // el logo de Factus llega en base64 (hasta ~270 KB)

app.get('/health', (_req, res) => res.json({ ok: true, servicio: 'agrocarnes-api' }));

app.use('/auth', authRouter);

// Todo lo demás requiere sesión iniciada.
app.use('/empresas', requireAuth, empresasRouter);
app.use('/productos', requireAuth, productosRouter);
app.use('/inventario', requireAuth, inventarioRouter);
app.use('/compras', requireAuth, comprasRouter);
app.use('/traslados', requireAuth, trasladosRouter);
app.use('/produccion', requireAuth, produccionRouter);
app.use('/ventas', requireAuth, ventasRouter);
app.use('/bodegas', requireAuth, bodegasRouter);
app.use('/terceros', requireAuth, tercerosRouter);
app.use('/recetas', requireAuth, recetasRouter);
app.use('/cartera', requireAuth, carteraRouter);
app.use('/notas-credito', requireAuth, notasCreditoRouter);
app.use('/gastos', requireAuth, gastosRouter);
app.use('/informes', requireAuth, informesRouter);
app.use('/cuentas-pago', requireAuth, cuentasPagoRouter);
app.use('/nomina', requireAuth, requireRole('admin'), nominaRouter);
app.use('/usuarios', requireAuth, requireRole('admin'), usuariosRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`agrocarnes-api escuchando en el puerto ${port}`);
  if (process.env.DIAN_JOB !== 'off') {
    iniciarJobDian();
    iniciarJobNotasCredito();
  }
});
