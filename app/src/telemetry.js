'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ExportResultCode, setGlobalErrorHandler } = require('@opentelemetry/core');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');

const pkg = require('../package.json');

// Probes run every few seconds against every pod. Counted, they are most of
// the request rate when nothing is happening and they drag the latency
// percentiles down. Kubernetes already acts on a failing probe.
const probes = new Set(['/health', '/live']);

// The SDK reports export failures only at its debug level, which also logs a
// line per request. A wrong endpoint or a rejected key would otherwise look
// exactly like working telemetry, so report the transitions instead.
function reportFailures(exporter, signal) {
  const inner = exporter.export.bind(exporter);
  let healthy = true;

  exporter.export = (items, done) => {
    inner(items, (result) => {
      const ok = result.code === ExportResultCode.SUCCESS;
      if (!ok && healthy) {
        console.error(`telemetry: ${signal} export failing:`, result.error?.message);
      } else if (ok && !healthy) {
        console.log(`telemetry: ${signal} export recovered`);
      }
      healthy = ok;
      done(result);
    });
  };

  return exporter;
}

let sdk = null;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // The default handler prints the whole error object, stack included, every
  // export interval. reportFailures already covers the transitions.
  setGlobalErrorHandler((err) => console.error('telemetry:', err.message || err));

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'relay',
      'service.version': pkg.version,
    }),
    traceExporter: reportFailures(new OTLPTraceExporter(), 'trace'),
    // Plural. The singular `metricReader` in this SDK version's README is
    // accepted and then ignored, so no metrics are ever produced.
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: reportFailures(new OTLPMetricExporter(), 'metric'),
        exportIntervalMillis: 30000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => probes.has((req.url || '').split('?')[0]),
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  sdk.start();
  console.log(`telemetry exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
}

function shutdown() {
  return sdk ? sdk.shutdown() : Promise.resolve();
}

module.exports = { shutdown };
