'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
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

let sdk = null;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'relay',
      'service.version': pkg.version,
    }),
    traceExporter: new OTLPTraceExporter(),
    // Plural. The singular `metricReader` in this SDK version's README is
    // accepted and then ignored, so no metrics are ever produced.
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
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
