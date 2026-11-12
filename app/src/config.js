'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.error(`environment variable ${name} must be an integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

module.exports = {
  port: int('PORT', 3000),
  databaseUrl: required('DATABASE_URL'),
  signingSecret: required('SIGNING_SECRET'),
  poolMax: int('PG_POOL_MAX', 25),
  // 0 means "no limit"
  dedupeMaxEntries: int('DEDUPE_MAX_ENTRIES', 0),
  logFile: process.env.LOG_FILE || '',
  archiveBucket: process.env.ARCHIVE_BUCKET || '',
};
