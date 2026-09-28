import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { requireAuth } from './middleware/auth.js';
import { router as authRouter } from './routes/auth.js';
import { router as empresasRouter } from './routes/empresas.js';
import { router as productosRouter } from './routes/productos.js';
import { router as inventarioRouter } from './routes/inventario.js';
import { router as comprasRouter } from './routes/compras.js';
import { router as trasladosRouter } from './routes/traslados.js';
import { router as produccionRouter } from './routes/produccion.js';
import { router as ventasRouter } from './routes/ventas.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));
app.use(express.json());

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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`agrocarnes-api escuchando en el puerto ${port}`);
});
