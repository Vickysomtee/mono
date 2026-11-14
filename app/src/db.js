'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('idle database client error:', err.message);
});

module.exports = { pool };
