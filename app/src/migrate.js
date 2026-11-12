'use strict';

const { Client } = require('pg');
const config = require('./config');

const LOCK_ID = 915270;

const migrations = [
  {
    version: 1,
    name: 'create events',
    sql: `
      CREATE TABLE events (
        id              uuid PRIMARY KEY,
        idempotency_key text NOT NULL,
        payload         jsonb NOT NULL,
        received_at     timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    version: 2,
    name: 'add signature and backfill',
    sql: `
      ALTER TABLE events ADD COLUMN signature text;
      UPDATE events SET signature = '' WHERE signature IS NULL`,
  },
  {
    version: 3,
    name: 'unique idempotency key',
    // CONCURRENTLY cannot run inside a transaction, so this one is not wrapped
    concurrent: true,
    sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS events_idempotency_key
            ON events (idempotency_key)`,
  },
];

async function apply(client, m) {
  if (m.concurrent) {
    await client.query(m.sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    return;
  }

  await client.query('BEGIN');
  try {
    await client.query(m.sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      console.log(`migrate: applying ${m.version} (${m.name})`);
      await apply(client, m);
    }

    console.log('migrate: up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    await client.end();
  }
}

main().catch((err) => {
  console.error('migrate: failed:', err.message);
  process.exit(1);
});
