# Observability

The app exports OpenTelemetry over OTLP/HTTP. SigNoz Cloud is the backend.
Nothing in this repo creates dashboards or alerts, because they are SigNoz-side
objects; what the repo guarantees is that the data behind them arrives with the
attributes the queries need.

## Wiring

Per environment, outside this repo for production:

| Where | Key | Production value |
|---|---|---|
| ConfigMap `relay-env` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://ingest.<region>.signoz.cloud:443` |
| ConfigMap `relay-env` | `DEPLOY_ENV` | `production` |
| Secret `relay-secrets` | `OTEL_EXPORTER_OTLP_HEADERS` | `signoz-ingestion-key=<key>` |

`signoz-ingestion-key` is the current header. The `signoz-access-token` you will
find in older guides is deprecated.

All three are optional. With no endpoint set the SDK never starts, which is how
kind and CI run without a backend.

`k8s/local/` has a collector with a debug exporter so the pipeline can be
checked locally without a key. Production does not get it.

## What arrives

`http.server.request.duration`, a histogram, one series per
`http.route` x `http.response.status_code`, unsampled. Everything below is
derived from it:

| Ask | From |
|---|---|
| Requests per second | rate of the histogram count |
| p95, p99 | quantiles over the buckets |
| Error rate | count where `http.response.status_code >= 500`, over total |
| Erroring endpoints | the same, grouped by `http.route` |

`http.route` is the Express route, so `GET /events/:id` is one series rather
than one per event id.

Traces are sampled at 10% (`OTEL_TRACES_SAMPLER_ARG` in `relay-config`). This
is why metrics exist as their own pipeline: deriving the rate from sampled spans
would report a tenth of the real traffic. Traces are for looking at one slow
request, metrics are for the numbers.

A span for `POST /events` carries the `pg` insert underneath it, which is the
view that answers "us or the database" without reading Postgres logs.

The `pg` instrumentation also exports `db.client.connection.count`,
`.max` and `.pending_requests` with no extra code. That is the pool saturation
signal, and `max` reads 8, matching `PG_POOL_MAX`.

`/health` and `/live` are excluded. They are probed every few seconds by every
pod, so counted they are most of the request rate when nothing is happening and
they pull the percentiles down. A failing probe is already acted on by
Kubernetes and covered by the restart alert below.

## Confirming it works

The startup line only proves the SDK started:

```
telemetry exporting to https://ingest.<region>.signoz.cloud:443
```

A rejected key or a wrong endpoint shows up as one line per signal, and one
more when it recovers:

```
telemetry: trace export failing: <reason>
telemetry: metric export failing: <reason>
telemetry: trace export recovered
```

If neither appears and data is not in SigNoz, the SDK never started, which
means `OTEL_EXPORTER_OTLP_ENDPOINT` did not reach the pod.

Pods need outbound 443 to `ingest.<region>.signoz.cloud`. The nodes are in
public subnets, so this works today, but an egress NetworkPolicy would break it
and the only symptom is the export-failing line above.
