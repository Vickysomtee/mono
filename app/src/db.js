'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  connectionTimeoutMillis: 2000,
  // pg-pool's own default, written down because the connection budget depends
  // on it. `min` is 0, so a pod that goes quiet drops to zero connections
  // after this and stops holding part of the 100 the database allows.
  idleTimeoutMillis: 10000,
  // Connections otherwise live forever. After a failover the pool can keep
  // sockets to the old primary until a query finally errors on one.
  maxLifetimeSeconds: config.pgMaxLifetimeSeconds,
});

pool.on('error', (err) => {
  console.error('idle database client error:', err.message);
});

module.exports = { pool };
