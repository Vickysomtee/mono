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

## Alerts to create

Thresholds are starting points, not measured SLOs. The load test ran at 400 rps
with p50 10ms, p95 19ms, p99 56ms and no errors, so these sit well above
observed healthy behaviour.

| Alert | Condition | Why this number |
|---|---|---|
| 5xx rate | `http.response.status_code >= 500` over total > 1% for 5m | Clients retry hard on anything that is not a 409, so errors amplify. |
| p99 latency | p99 of `http.server.request.duration` > 500ms for 10m | Roughly 10x the observed p99. Below that is noise. |
| Pool saturation | `db.client.connection.pending_requests` > 0 for 2m | Leading indicator. Requests queue here before `connectionTimeoutMillis` turns them into 500s, so this fires before the 5xx alert. |
| Pod restarts | `kube_pod_container_status_restarts_total` increasing, or OOMKilled | Needs the SigNoz k8s-infra chart, which is a separate install from app instrumentation. |

The first three come from app data that is already arriving. The fourth does
not: it needs cluster metrics collected, which nobody has set up yet.

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

## A sampling consequence worth knowing

SigNoz's Services view builds its numbers from the spans it receives. At 10%
sampling the request rate there reads about a tenth of the truth. Latency
percentiles are roughly right, because a uniform sample does not shift the
distribution, and error rate as a ratio is roughly right too, but counts are
not.

So build the RED dashboard and the alerts on `http.server.request.duration`,
which is unsampled, and treat the Services view as a way in to traces rather
than a source of numbers. If you would rather have one source of truth, set
`OTEL_TRACES_SAMPLER_ARG` to `1.0` in `relay-config` and accept the span
volume: at 400 rps that is roughly 34 million spans a day.

## Not done

No logs pipeline. Access logs go to stdout as JSON and are whatever the cluster
does with stdout. Correlating a log line to a trace needs the trace id in the
log, which is a small change and worth doing once there is a reason to.

Export to SigNoz Cloud itself is unverified. What was checked is that the app
emits the metrics and spans above, with those attributes, against a real
collector. The hop from collector to SigNoz is endpoint and key.
