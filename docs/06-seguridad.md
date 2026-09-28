# 06 · Seguridad y control de acceso

## Autenticación

- Inicio de sesión con correo y contraseña contra la tabla `usuario`.
- Las contraseñas se almacenan únicamente como hash **bcrypt** (10 rondas);
  no existe forma de recuperar una contraseña, solo de reemplazarla
  (`scripts/crear_admin.js`).
- Tras el inicio de sesión el servidor emite un **JWT** firmado con
  `JWT_SECRET` (secreto aleatorio de 96 caracteres hexadecimales generado en
  la instalación), con vigencia de 12 horas. El token viaja en el encabezado
  `Authorization: Bearer …` y se guarda en el navegador del usuario.
- Un token inválido o vencido devuelve 401 y la aplicación cierra la sesión.
- Los usuarios inactivos (`activo = false`) no pueden autenticarse.

## Autorización

| Rol | Puede |
| --- | --- |
| operador | Registrar compras, traslados, producciones y ventas; consultar inventario; crear productos, clientes y proveedores |
| admin | Todo lo anterior + configurar la cuenta de Arco de cada empresa (`/empresas/:id/arco`) |

Todas las rutas de la API, salvo `/auth/login` y `/health`, exigen un token
válido (`requireAuth`); las de configuración exigen además rol admin
(`requireRole('admin')`).

## Transporte y red

- Toda la comunicación navegador ↔ servidor va por **HTTPS** con
  certificados Let's Encrypt renovados automáticamente por Certbot; HTTP
  redirige a HTTPS.
- La API solo acepta peticiones del origen de la aplicación (CORS
  restringido a `https://agrocarnes.agrofranpabel.com`).
- PostgreSQL escucha únicamente en `localhost`; no es accesible desde
  Internet. El usuario `agrocarnes_app` solo tiene privilegios sobre la base
  `agrocarnes`.
- El acceso administrativo al servidor es por SSH con llave (sin
  contraseña) o por la consola de AWS con autenticación de la cuenta.

## Secretos

| Secreto | Dónde vive | Quién lo ve |
| --- | --- | --- |
| Contraseña de la base de datos | `/var/www/agrocarnes-backend/.env` (permisos 600) | Administrador del servidor |
| JWT_SECRET | `.env` | Administrador del servidor |
| Credenciales de Arco | `empresa.arco_config` en la base de datos | Se escriben desde la pantalla de Configuración; la API nunca devuelve la contraseña |
| Contraseñas de usuarios | Solo hash bcrypt | Nadie |

El archivo `.env` está excluido del control de versiones (`.gitignore`). El
repositorio no contiene ningún secreto.

## Integridad y trazabilidad de la información

- **Sin borrado:** la API no expone eliminación de compras, traslados,
  órdenes de producción, facturas ni movimientos de inventario.
- **Autoría:** cada movimiento de inventario registra el usuario
  (`creado_por`) y la fecha/hora del servidor.
- **Consecutivos:** el número interno de factura se asigna dentro de una
  transacción con bloqueo de fila (`update … returning`), por lo que no puede
  repetirse ni saltarse por concurrencia. El número oficial lo asigna Arco
  con la resolución DIAN.
- **Historial del código:** todo cambio al software queda en Git con fecha,
  autor y descripción; los repositorios son públicos y su historial es
  verificable por terceros.
- **Migraciones:** los cambios de estructura de datos quedan registrados en
  `schema_migrations` con fecha de aplicación.

## Registro de accesos y actividad

A la fecha el sistema registra la autoría de cada documento (usuario) pero
**no** lleva una bitácora separada de inicios de sesión ni de consultas.
Está previsto como mejora (ver CHANGELOG · pendientes).

## Gestión de usuarios

Los usuarios se crean con `scripts/crear_admin.js` (rol admin) o directamente
en la tabla `usuario` por el administrador. La pantalla de administración de
usuarios está prevista como mejora. Cuando un empleado se retira, se marca
`activo = false`; el historial de sus movimientos se conserva.
