'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const config = require('./config');
const { pool } = require('./db');

function logRequest(req, res, startedAt) {
  process.stdout.write(
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

// Replays are answered from this cache when we have seen the key on this pod,
// and from the unique index on idempotency_key when we have not.
const seen = new Map();

function remember(key, id) {
  seen.set(key, id);
  if (seen.size > config.dedupeMaxEntries) {
    seen.delete(seen.keys().next().value);
  }
}

const s3 = config.archiveBucket ? new S3Client({}) : null;

async function archive(id, payload) {
  if (!s3) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: config.archiveBucket,
      Key: `events/${id}.json`,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
    }),
  );
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));
  next();
});

let shuttingDown = false;

app.get('/live', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health', async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ status: 'draining' });
  }
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
  } catch (err) {
    if (err.code === '23505') {
      try {
        const { rows } = await pool.query(
          'SELECT id FROM events WHERE idempotency_key = $1',
          [key],
        );
        if (rows.length > 0) {
          remember(key, rows[0].id);
          return res.status(409).json({ id: rows[0].id, duplicate: true });
        }
      } catch (lookupErr) {
        console.error('failed to resolve duplicate:', lookupErr.message);
      }
    }
    console.error('failed to store event:', err.message);
    return res.status(500).json({ error: 'internal error' });
  }

  remember(key, id);
  res.status(201).json({ id, signature });

  archive(id, payload).catch((err) => console.error('archive failed:', id, err.message));
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

const server = app.listen(config.port, () => {
  console.log(`relay listening on :${config.port} (pool max ${config.poolMax})`);
});

// Must stay above the ALB idle timeout or the balancer reuses sockets we just closed.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);

  server.close(() => {
    pool.end().then(() => process.exit(0), () => process.exit(0));
  });

  setTimeout(() => {
    console.error('grace period expired, exiting');
    process.exit(1);
  }, config.shutdownGraceMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
