# 07 · Operación, respaldos y continuidad

## Despliegue y actualización

La instalación y cada actualización se hacen con **un solo comando**, desde
la terminal del servidor (usuario `ubuntu`):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Ecocargapp/Backend-Agrocarnes/main/scripts/setup-servidor.sh) correo-del-admin@dominio.com
```

El script (`scripts/setup-servidor.sh`) es **idempotente**: se puede repetir
sin efectos secundarios. En cada ejecución:

1. Verifica herramientas (node, npm, pm2, psql, nginx).
2. Crea la base de datos y el usuario si no existen (con contraseña aleatoria).
3. Sincroniza el código del backend con la rama `main` de GitHub.
4. Genera `.env` la primera vez (secretos aleatorios); después lo conserva.
5. Instala dependencias y aplica las migraciones pendientes.
6. Crea el administrador (o fija su clave si se pasa como 2.º argumento).
7. Arranca o reinicia `agrocarnes-api` en pm2 y comprueba `/health`.
8. Instala el respaldo diario en cron y ejecuta uno de inmediato.
9. Sincroniza el frontend.
10. Instala la configuración de nginx la primera vez (después la conserva,
    porque Certbot la modifica) y recarga nginx.
11. Emite o reinstala el certificado HTTPS cuando el DNS apunta al servidor.

Toda versión desplegada corresponde a un commit identificable en GitHub
(`git -C /var/www/agrocarnes-backend log -1`).

## Respaldos

| Qué | Cómo | Dónde | Retención |
| --- | --- | --- | --- |
| Base de datos | `pg_dump` comprimido, diario 02:30 (cron), `scripts/respaldo-bd.sh` | `/var/backups/agrocarnes/agrocarnes-AAAAMMDD-HHMMSS.sql.gz` (permisos 600) | 30 días |
| Código y documentación | Git, en GitHub | github.com/Ecocargapp | Permanente (historial completo) |
| Configuración (`.env`, nginx, certificados) | Manual | Servidor | — |

Registro de ejecuciones: `/var/log/agrocarnes-respaldo.log`.

**Pendiente (recomendado):** copia diaria de los respaldos fuera del
servidor (por ejemplo a un bucket S3 con versionado) para cubrir la pérdida
total de la instancia. Ver CHANGELOG · pendientes.

## Restauración

```bash
# en el servidor, con la API detenida
pm2 stop agrocarnes-api
sudo -u postgres psql -c "drop database agrocarnes;" -c "create database agrocarnes owner agrocarnes_app;"
gunzip -c /var/backups/agrocarnes/agrocarnes-AAAAMMDD-HHMMSS.sql.gz | sudo -u postgres psql -d agrocarnes
pm2 start agrocarnes-api
```

Para reconstruir el servidor completo desde cero: crear una instancia Ubuntu
con node, pm2, PostgreSQL, nginx y certbot; correr el script de despliegue;
restaurar el último respaldo; apuntar el DNS.

## Monitoreo y registros

| Qué | Comando |
| --- | --- |
| Estado de los procesos | `pm2 ls` |
| Registro de la API (errores, envíos a Arco) | `pm2 logs agrocarnes-api` |
| Salud de la API | `curl https://api-agrocarnes.agrofranpabel.com/health` |
| nginx | `sudo nginx -t`, `/var/log/nginx/access.log`, `error.log` |
| Certificado | `sudo certbot certificates` |
| Facturas con problema DIAN | `select consecutivo, estado_dian, dian_mensaje from factura_venta where estado_dian in ('error','rechazada','sin_configurar');` |

pm2 reinicia la API si falla y la levanta al reiniciar el servidor (`pm2 save`).

## Entorno de pruebas

El repositorio permite levantar todo en un computador local (README):
PostgreSQL local, `npm run migrate`, `npm run dev`, frontend servido con
cualquier servidor estático. Con `DIAN_JOB=off` no se envía nada a Arco. Las
pruebas previas a cada entrega se ejecutan así, contra un simulador de la API
de Arco, antes de desplegar.

## Responsables

| Actividad | Responsable |
| --- | --- |
| Desarrollo, despliegue, administración del servidor | Jonatan Botero |
| Operación diaria (compras, producción, ventas) | Personal de cada empresa con usuario propio |
| Facturación electrónica (resolución, certificado, contrato) | Cada empresa con Arco |
| Revisión contable y tributaria | Contador de cada empresa |
