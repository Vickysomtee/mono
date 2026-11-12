#!/usr/bin/env node
'use strict';

// Open-loop load generator for relay. No dependencies.
//
//   node tools/load.js --url http://localhost:8080 --rps 150 --duration 300
//
// Sends POST /events at a fixed rate. A share of requests (--replay) reuse an
// Idempotency-Key that was already sent, the way a retrying client would.

const http = require('node:http');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const args = { url: 'http://localhost:8080', rps: 150, duration: 300, 'payload-bytes': 8192, replay: 0.05 };
  for (let i = 2; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!(name in args) || argv[i + 1] === undefined) {
      console.error(`usage: load.js [--url URL] [--rps N] [--duration SECONDS] [--payload-bytes N] [--replay FRACTION]`);
      process.exit(2);
    }
    args[name] = name === 'url' ? argv[i + 1] : Number(argv[i + 1]);
  }
  return args;
}

const args = parseArgs(process.argv);
const target = new URL('/events', args.url);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const filler = crypto.randomBytes(Math.ceil(args['payload-bytes'] / 2)).toString('hex');

const recentKeys = [];
let total = newWindow();
let window = newWindow();
let inFlight = 0;

function newWindow() {
  return { sent: 0, statuses: {}, errors: {}, latencies: [] };
}

function record(bucket, status, error, ms) {
  if (error) bucket.errors[error] = (bucket.errors[error] || 0) + 1;
  else bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
  if (ms !== undefined) bucket.latencies.push(ms);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(bucket) {
  const sorted = bucket.latencies.slice().sort((a, b) => a - b);
  const statuses = Object.entries(bucket.statuses).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  const errors = Object.entries(bucket.errors).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  return `sent=${bucket.sent} status[${statuses}] errors[${errors}] ` +
    `p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms p99=${percentile(sorted, 99)}ms`;
}

function sendOne() {
  let key;
  if (recentKeys.length > 0 && Math.random() < args.replay) {
    key = recentKeys[Math.floor(Math.random() * recentKeys.length)];
  } else {
    key = crypto.randomUUID();
  }

  const body = JSON.stringify({ type: 'order.updated', sentAt: new Date().toISOString(), data: filler });
  const startedAt = Date.now();
  total.sent++;
  window.sent++;
  inFlight++;

  const req = http.request(
    target,
    {
      method: 'POST',
      agent,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Idempotency-Key': key,
      },
    },
    (res) => {
      res.resume();
      res.on('end', () => {
        const ms = Date.now() - startedAt;
        record(total, res.statusCode, null, ms);
        record(window, res.statusCode, null, ms);
        inFlight--;
        // only keys the server has acknowledged are candidates for a retry
        if (res.statusCode === 201) {
          recentKeys.push(key);
          if (recentKeys.length > 2000) recentKeys.shift();
        }
      });
    },
  );
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
  req.on('error', (err) => {
    const code = err.code || err.message;
    record(total, null, code);
    record(window, null, code);
    inFlight--;
  });
  req.end(body);
}

console.log(`load: ${args.rps} req/s for ${args.duration}s -> ${target.href} ` +
  `(payload ~${args['payload-bytes']}B, replay ${args.replay})`);

const tickMs = 50;
const startedAt = Date.now();
let scheduled = 0;

const ticker = setInterval(() => {
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed >= args.duration) {
    clearInterval(ticker);
    clearInterval(reporter);
    const waitForInFlight = setInterval(() => {
      if (inFlight > 0 && Date.now() - startedAt < (args.duration + 6) * 1000) return;
      clearInterval(waitForInFlight);
      console.log(`\ntotal: ${summarise(total)}`);
      agent.destroy();
    }, 100);
    return;
  }
  const shouldHaveSent = Math.floor(elapsed * args.rps);
  while (scheduled < shouldHaveSent) {
    sendOne();
    scheduled++;
  }
}, tickMs);

const reporter = setInterval(() => {
  const t = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[${String(t).padStart(4)}s] ${summarise(window)}`);
  window = newWindow();
}, 5000);
