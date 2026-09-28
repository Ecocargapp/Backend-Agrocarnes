// pm2 start ecosystem.config.cjs
// Proceso propio de Agrocarnes, separado de agrosoft-api.
module.exports = {
  apps: [
    {
      name: 'agrocarnes-api',
      cwd: __dirname,
      script: 'src/server.js',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 10,
      watch: false,
    },
  ],
};
