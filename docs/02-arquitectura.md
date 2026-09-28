# 02 · Arquitectura técnica

## Componentes

```
 Navegador del usuario
   │  HTTPS
   ▼
 nginx (reverse proxy + archivos estáticos)  ── certificados Let's Encrypt (Certbot)
   ├── agrocarnes.agrofranpabel.com      → /var/www/app-agrocarnes  (frontend estático)
   └── api-agrocarnes.agrofranpabel.com  → http://127.0.0.1:4001    (API)
                                              │
                                   agrocarnes-api (Node.js 20 + Express, proceso pm2)
                                              │            │
                                   PostgreSQL 18 (BD "agrocarnes")   Arco ERP (API REST, HTTPS)
```

| Componente | Tecnología | Ubicación |
| --- | --- | --- |
| Frontend | HTML, CSS y JavaScript (módulos ES) sin framework | `/var/www/app-agrocarnes` · repo Frontend-Agrocarnes |
| API | Node.js 20, Express 4, módulos ES | `/var/www/agrocarnes-backend` · repo Backend-Agrocarnes |
| Base de datos | PostgreSQL 18, base `agrocarnes`, usuario `agrocarnes_app` | Mismo servidor, instalación local |
| Gestor de procesos | pm2 7 (`agrocarnes-api`, reinicio automático, arranque con el sistema) | Servidor |
| Servidor web | nginx con TLS (Let's Encrypt) | Servidor |
| Servidor | AWS EC2 t3.micro, Ubuntu 26.04, región us-east-2 (Ohio), IP elástica 18.226.158.249 | Cuenta AWS del propietario |
| Facturación electrónica | Arco ERP, API REST v2 | Externo (arco365.com) |

El mismo servidor aloja el sistema AgroSoft (granjas de Agro Franpabel); los
dos sistemas están **completamente separados**: base de datos distinta,
proceso pm2 distinto, carpetas distintas, subdominios distintos. Comparten
solo la máquina, nginx y PostgreSQL como servicios.

## Estructura del código (backend)

```
src/
  server.js              arranque de Express, rutas, CORS, job de facturación
  db/pool.js             conexión a PostgreSQL
  db/migrate.js          aplicación de migraciones (tabla schema_migrations)
  db/inventario.js       ÚNICA función que mueve inventario (registrarMovimiento)
  middleware/auth.js     verificación de JWT y de rol
  routes/                un archivo por recurso: auth, empresas, productos, bodegas,
                         terceros, inventario, compras, traslados, recetas, produccion, ventas
  dian/arco.js           cliente HTTP de Arco (login, token, reintento en 401)
  dian/cliente.js        lógica de facturación electrónica y job de reintentos
migrations/              001_init.sql, 002_..., 003_... (se aplican una sola vez, en orden)
scripts/setup-servidor.sh  instalación/actualización idempotente en el servidor
scripts/crear_admin.js     alta o cambio de clave del administrador
nginx/agrocarnes.conf      configuración base de nginx
```

## Principios de diseño relevantes para auditoría

1. **Un solo punto de entrada al inventario.** Toda variación de existencias
   pasa por `registrarMovimiento`, que inserta la fila en
   `movimiento_inventario` y actualiza `existencia` en la **misma transacción**.
   No hay rutas que modifiquen `existencia` directamente.
2. **Transacciones.** Compras, traslados, órdenes de producción y ventas se
   registran en una transacción de base de datos: o queda todo (documento,
   detalle y movimientos) o no queda nada.
3. **Sin borrado de documentos.** No existen endpoints para eliminar compras,
   traslados, producciones ni facturas. Las correcciones se hacen con
   documentos nuevos (y, cuando se implemente, notas crédito).
4. **Trazabilidad.** Cada movimiento de inventario guarda tipo, cantidad,
   costo, fecha/hora, usuario (`creado_por`) y el documento que lo originó
   (`referencia_tipo`, `referencia_id`).
5. **Costo promedio ponderado.** Las entradas recalculan el costo promedio;
   las salidas se valoran al promedio vigente. La fórmula está en
   `db/inventario.js` y en el documento 04.
6. **Migraciones versionadas.** El esquema de la base de datos solo cambia
   mediante archivos en `migrations/`, aplicados una vez y registrados en
   `schema_migrations` con fecha.

## Dependencias externas (npm)

| Paquete | Uso |
| --- | --- |
| express | servidor HTTP / API REST |
| pg | cliente PostgreSQL |
| jsonwebtoken | tokens de sesión (JWT) |
| bcryptjs | hash de contraseñas |
| cors | control de orígenes permitidos |
| dotenv | variables de entorno (.env) |

Las versiones exactas están fijadas en `package-lock.json`.

## Variables de entorno (`.env`, no versionado)

`PORT`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
`JWT_SECRET`, `JWT_EXPIRES_IN`, `CORS_ORIGIN`, `DIAN_JOB` (`off` desactiva el
job de facturación, solo para pruebas). Las credenciales de Arco **no** van en
`.env`: se guardan por empresa en la base de datos (`empresa.arco_config`).
