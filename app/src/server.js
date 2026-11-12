'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const { pool } = require('./db');

// ---------------------------------------------------------------- logging

let accessLog = process.stdout;
if (config.logFile) {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  accessLog = fs.createWriteStream(config.logFile, { flags: 'a' });
}

function logRequest(req, res, startedAt) {
  accessLog.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      key: req.get('Idempotency-Key') || null,
    }) + '\n',
  );
}

// ------------------------------------------------------------ idempotency

// Replays are answered from this cache when this pod has seen the key, and
// from the unique index on idempotency_key when it has not.
const seen = new Map();

function remember(key, id) {
  seen.set(key, id);
  if (seen.size > config.dedupeMaxEntries) {
    seen.delete(seen.keys().next().value);
  }
}

async function existingId(key) {
  const { rows } = await pool.query('SELECT id FROM events WHERE idempotency_key = $1', [key]);
  return rows.length > 0 ? rows[0].id : null;
}

// ---------------------------------------------------------------- archive

let s3 = null;

async function archive(id, payload) {
  if (!config.archiveBucket) return;
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  if (!s3) s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: config.archiveBucket,
      Key: `events/${id}.json`,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
    }),
  );
}

// -------------------------------------------------------------------- app

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
});

app.post('/events', async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  const cached = seen.get(key);
  if (cached) {
    return res.status(409).json({ id: cached, duplicate: true });
  }

  const id = crypto.randomUUID();
  const payload = req.body;
  const signature = crypto
    .createHmac('sha256', config.signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex');

  try {
    await pool.query(
      'INSERT INTO events (id, idempotency_key, payload, signature) VALUES ($1, $2, $3, $4)',
      [id, key, payload, signature],
    );
    remember(key, id);
    await archive(id, payload);
    res.status(201).json({ id, signature });
  } catch (err) {
    if (err.code === '23505') {
      try {
        const previous = await existingId(key);
        if (previous) {
          remember(key, previous);
          return res.status(409).json({ id: previous, duplicate: true });
        }
      } catch (lookupErr) {
        console.error('failed to resolve duplicate:', lookupErr.message);
      }
    }
    console.error('failed to store event:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/events/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, idempotency_key, payload, signature, received_at FROM events WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('failed to read event:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(config.port, () => {
  console.log(`relay listening on :${config.port} (pool max ${config.poolMax})`);
});
