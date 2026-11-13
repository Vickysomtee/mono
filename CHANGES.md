# Changes

Every change in this branch, file by file, with the reason. `NOTES.md` has the
ship call and the load test evidence; this is the line-by-line companion to it.

Changes marked **Blocker** are the ones that stopped `make up` producing a
working service.

## app/Dockerfile

| Change | Why |
|---|---|
| `COPY package.json .` to `COPY package.json package-lock.json ./` | **Blocker.** `npm ci` refuses to run without a lockfile, so the build failed before anything else could be reached. |
| `FROM node:22` to `node:22-slim` | The full Debian image is about 1.1 GB with a large CVE surface. The image is now 258 MB. |
| `COPY . .` + `RUN rm -f .env` to `COPY src ./src` | The old form copied `.env` into a layer and deleted it in a later one. Deleted files stay readable in the earlier layer, so the staging password shipped inside any image pushed to ECR. |
| Added `USER node` | The container ran as root. Nothing needs root at runtime. |
| `EXPOSE 3000` to `8080` | Simply wrong, and misleading to the next person. |
| `ENTRYPOINT ["sh", "./entrypoint.sh"]` to `CMD ["node", "src/server.js"]` | `sh` became PID 1 and npm does not forward signals, so SIGTERM never reached node and every pod was SIGKILLed after the grace period with requests in flight. |
| `--max-old-space-size=512` to `384` | The heap was above the 256Mi container limit, so the kernel killed the container before V8 had any reason to collect. Raising this is what the previous owner did about the OOMs, and it made them worse. |
| Split into a `deps` build stage and removed npm from the runtime image | Nothing at runtime shells out to npm, and the npm that `node:22-slim` ships carries its own bundled dependency tree - `pacote`, `sigstore`, `picomatch`, `brace-expansion`, `ip-address`. Those were the only 10 HIGH findings in the Trivy job, and none of them are the app's dependencies, which `npm audit` reports clean. Deleting a package manager from a production image is the fix; muting the scanner is not. |

## app/.dockerignore (new)

`.env`, `node_modules`, `npm-debug.log`, `Dockerfile`, `.dockerignore`. The
correct way to keep secrets out of a build context, replacing the `rm -f .env`
that did not work.

## app/entrypoint.sh (deleted)

It ran `npm run migrate && npm start`. That put npm in the signal path and
meant every replica ran migrations on boot with no locking. Migrations are an
init container now.

## app/package.json

`"dev": "node --env-file=.env src/server.js"` to `"node src/server.js"`. The
`.env` it referenced no longer exists.

Added `@opentelemetry/sdk-node`, the OTLP trace and metric exporters, and the
`http`, `express` and `pg` instrumentations. About 180 packages and 30 MB on
the image, 258 MB to 288 MB.

## app/src/telemetry.js (new)

OpenTelemetry over OTLP to SigNoz Cloud. Full write-up in
`docs/OBSERVABILITY.md`; the reasons for the choices are here.

| Decision | Why |
|---|---|
| OTLP, not a `/metrics` endpoint | SigNoz is OTLP-native. One pipeline instead of a scrape plus a separate tracing setup, and traces come out of the same instrumentation. |
| `http`, `express` and `pg` instrumentations, not `auto-instrumentations-node` | The auto package pulls about thirty instrumentations for a service that speaks HTTP and Postgres. These three are what is used. |
| `express` instrumentation included specifically | It is what produces `http.route`. Without it `GET /events/:id` is one metric series per event id, which is a cardinality problem rather than a dashboard. |
| `metricReaders: [...]`, plural | The singular `metricReader` that this SDK version's own README documents is accepted and silently ignored. Traces flow, no metric is ever produced, and nothing errors. Caught by checking what reached the collector rather than that the SDK started. |
| Metrics unsampled, traces at 10% | RED numbers have to be right, and spans are the expensive part. Deriving the rate from spans sampled at 10% reports a tenth of the real traffic. |
| `/health` and `/live` excluded | Probed every few seconds by every pod. Counted, they are most of the request rate at idle and they drag the percentiles down. Kubernetes already acts on a failing probe. |
| Starts only if `OTEL_EXPORTER_OTLP_ENDPOINT` is set | Otherwise the SDK defaults to `localhost:4318` and fills the log with connection errors in kind and in CI. |
| No custom metrics | The `pg` instrumentation already exports `db.client.connection.count`, `.max` and `.pending_requests`, which is the pool saturation signal I was going to write by hand. |
| Wrapped both exporters to log export failures and recoveries | The SDK reports them only at its debug level, which also logs a line per request. A wrong endpoint or a rejected ingestion key otherwise looks exactly like working telemetry. One line per transition, not per attempt. |
| `setGlobalErrorHandler` to a one-line log | The default handler prints the whole error object with its stack on every export interval, which during a backend outage is a stack trace every 30 seconds per pod. |

## app/src/config.js

| Change | Why |
|---|---|
| `port` default 3000 to 8080 | The contract is 8080 everywhere. A default that contradicts it invites the mismatch that broke this deploy. |
| `poolMax` default 25 to 8 | See the connection budget under `k8s/base/configmap.yaml`. |
| `dedupeMaxEntries` default 0 to 10000, dropped the `0 means "no limit"` comment | A default meaning unbounded is a footgun: omitting the variable gave you an infinite cache. |
| Removed `logFile` | Backs out file logging entirely. |
| Added `shutdownGraceMs` | Needed by the drain path so the hard-exit timer is tunable. |

## app/src/migrate.js

| Change | Why |
|---|---|
| Added `pg_advisory_lock` around the whole run | With more than one replica, pods ran the same `ALTER TABLE` at the same time, giving duplicate-column errors and init crash loops. The lock serialises them and the loser finds the version already applied. |
| Wrapped the body in `try/finally` with `pg_advisory_unlock` and `client.end()` | Without it a failed migration leaks the lock and every other pod blocks forever. |
| New `apply()` using `BEGIN`/`COMMIT`/`ROLLBACK` | The DDL and its `schema_migrations` row now commit together. They used to be two separate statements, so a crash in between left the schema changed but unrecorded and the next run would re-apply it and fail. |
| Migration 3 to `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` | A non-concurrent index takes `ACCESS EXCLUSIVE` and blocks every write to `events` for the length of the build against production-sized data. `IF NOT EXISTS` makes a retry safe after a failed concurrent build. |
| Added a `concurrent` flag that skips the transaction for that migration | `CREATE INDEX CONCURRENTLY` errors inside a transaction block. The flag keeps everything else atomic. |
| Removed `SELECT pg_sleep(2)` from migration 2 | It stood in for a slow backfill. With migrations serialised behind a lock in an init container it only delays every pod's startup. This is the most debatable change here, since it removes a deliberate test fixture. |

Worth saying out loud: migration 3 fails outright if duplicate
`idempotency_key` rows already exist. That needs checking before it runs
anywhere real.

## app/src/server.js

### Idempotency

| Change | Why |
|---|---|
| `INSERT` to `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` | Dedupe was a per-process `Map`, which only works at the one replica staging ran. A retry landing on a pod that has not seen the key inserts, trips the unique index, falls into the generic `catch` and returns 500 where the contract says 409. Clients retry hard on anything else, so it amplified under exactly the traffic it existed to absorb. |
| On `rowCount === 0`, look the key up and return 409 with the original id | Makes the unique index the source of truth instead of pod-local memory, so every pod gives the same answer. |
| `rowCount === 0` with no row found logs and returns 500 | A conflict with nothing to conflict against is impossible, and should not quietly return a wrong 409. |
| `seen` holds the id instead of `{id, payload, signature}` | It was retaining the full 8 KB payload per key, about 3 MB/s at 400 rps against a 256Mi limit. That is the OOM in the handoff. |
| `remember()` bound applies unconditionally | Removes the "0 means unlimited" path so the cache cannot grow without limit through misconfiguration. |

This started as a `catch` on SQLSTATE 23505. I changed it to `ON CONFLICT`
after the load test filled the Postgres log with `duplicate key value violates
unique constraint` - roughly 20 lines a second at 400 rps with 5% replays,
enough to bury real errors and make a duplicate-key alarm useless.

### Shutdown and draining

| Change | Why |
|---|---|
| Captured the server handle and added `shutdown()` with SIGTERM/SIGINT handlers | There was no graceful shutdown at all. It now closes the listener, drains, closes the pool, with a hard-exit timer so a stuck connection cannot hang the pod past its grace period. |
| Added a `shuttingDown` flag; `/health` returns 503 `draining` | Takes the pod out of Service endpoints before the socket closes. Without it, "zero-downtime rolling updates" was not true. |
| Added `GET /live` | Liveness pointed at `/health`, which queries Postgres, with `failureThreshold: 2` and `periodSeconds: 5`. One slow database moment failed every pod within 10 seconds and restarted the whole deployment at once. `/live` only proves the process is up. |
| `keepAliveTimeout = 65000`, `headersTimeout = 66000` | Node's 5s default sits below the ALB's 60s idle timeout, so the balancer reuses sockets node has just closed. That is the usual source of random 502s behind an ALB. |

### Archive

| Change | Why |
|---|---|
| `await archive(...)` before the 201 to a fire-and-forget call after it | It was in the request path, so a slow or throttled bucket showed up directly in client latency, and an S3 error returned 500 for an event that was already committed - the client then retried something we had stored. Durable retries need an outbox, which is noted rather than built. |
| Hoisted the `@aws-sdk/client-s3` require to the top and build the client once | The lazy require inside the handler meant the first request on every cold pod paid the SDK load, a latency spike exactly when a new pod joins rotation. |

### Logging

| Change | Why |
|---|---|
| Removed the `fs`/`path` imports and the write stream; log to `process.stdout` | `LOG_FILE` wrote into the container's writable layer with no volume and no rotation, growing until the node hit DiskPressure and evicted workloads. It also meant `kubectl logs` showed nothing. Removing it is what makes `readOnlyRootFilesystem` possible. |

### Telemetry

| Change | Why |
|---|---|
| `require('./telemetry')` as the first statement | The instrumentation patches `express` and `pg` as they load, so it has to run before either require. |
| `telemetry.shutdown()` alongside `pool.end()` in the drain | Buffered spans and the pending metric interval would otherwise die with the pod, losing exactly the data from a shutdown you were trying to understand. |

## k8s/base/deployment.yaml

### Blockers

| Change | Why |
|---|---|
| `secretKeyRef.key: database-url` to `DATABASE_URL` | The Secret defines `DATABASE_URL` and keys are case-sensitive. The pod never left `CreateContainerConfigError`. |
| `containerPort: 3000` to `name: http, containerPort: 8080` | `PORT` was already 8080 in the ConfigMap, so the app listened there while Kubernetes probed and routed to 3000. Naming the port means the Service and probes reference the name and cannot drift again. |
| Added `imagePullPolicy: IfNotPresent` to every container | A `:latest` tag makes the kubelet default to `Always`, so it ignored the image `kind load` had just put on the node and tried to pull from Docker Hub. |
| Added the `migrate` init container | Moves migrations out of the app container, running once before the app against the same image. |
| Added the `wait-for-db` init container | `pg_isready` against `DATABASE_URL` every 2s, giving up after 120s. Without it the migrate container crash-loops on a cold cluster until the database answers, which self-heals but reads as a failure. |
| Added `requests.cpu: 250m` | The HPA scales on CPU utilisation, which is a percentage of the request. With only `limits.memory` set it had nothing to compute against and reported `<unknown>`. This is also what the scheduler packs against. |
| Added the telemetry env block | `OTEL_EXPORTER_OTLP_ENDPOINT` and `DEPLOY_ENV` from the `relay-env` ConfigMap, the ingestion key from `relay-secrets`, all `optional: true`, plus pod and node name through the downward API into `OTEL_RESOURCE_ATTRIBUTES`. Per-pod attribution is what made the cross-pod replay behaviour provable, and it is the same view you want in SigNoz. |

### Capacity and availability

| Change | Why |
|---|---|
| Removed the `replicas` field entirely | It was `1`. Setting it on a Deployment under an HPA means every apply writes that number back, so a deploy during busy traffic scales the service down and the HPA has to climb again. `minReplicas: 3` is the floor instead. This only works with metrics-server in the cluster, which is why that is now gated rather than assumed - see `docs/SCALING.md`. |
| Added `requests: cpu 250m, memory 256Mi` | CPU-utilisation scaling needs a CPU request to compute a ratio against. Only `limits.memory` was set, so the HPA reported `<unknown>` and sat at one replica. "Autoscaling is set up, 1-10 pods" was not true. |
| `limits.memory` 256Mi to 512Mi | Keeps the limit above the 384 MB heap so V8 can collect before the kernel intervenes. |
| `whenUnsatisfiable: DoNotSchedule` to `ScheduleAnyway` | In production the node group is pinned to a single subnet, so a strict zone spread buys nothing and risks unschedulable pods. |
| Added `terminationGracePeriodSeconds: 30` | Makes the drain window explicit rather than implied. |
| Added `preStop: sleep 5` | Gives endpoint deregistration time to propagate before the process stops accepting, closing the last gap in the rolling update. |

### Probes

| Change | Why |
|---|---|
| Added a `startupProbe` | Gives migrations and cold start up to 60s without liveness killing the pod mid-startup. |
| Added a `readinessProbe` on `/health` | There was no readiness probe at all, so pods took traffic before they could serve it. |
| `livenessProbe` moved to `/live` with looser thresholds | Separates "process is alive" from "database is reachable", and backs off thresholds aggressive enough to kill pods on a transient blip. |

### Security

| Change | Why |
|---|---|
| Pod `securityContext` (`runAsNonRoot`, `runAsUser`, `seccompProfile`) and per-container (`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities: drop: [ALL]`) | There was no security context at all. Only possible now that nothing writes a log file. |

## k8s/local/relay-env.yaml (new) and k8s/local/otel-collector.yaml (new)

`relay-env` is the per-environment, non-secret half of the config: the OTLP
endpoint and `DEPLOY_ENV`. Production has its own copy outside the repo, the
same as the real Secret. The endpoint is not a secret, so it does not belong in
`relay-secrets`; the ingestion key does and stays there.

`otel-collector.yaml` is a collector with a debug exporter, so the pipeline can
be checked locally and in CI without a SigNoz key. It is in `local/`, so
production never gets it.

## k8s/local/metrics-server.yaml (new)

Upstream v0.7.2 `components.yaml` with one line added, `--kubelet-insecure-tls`,
because kind's kubelets serve self-signed certificates and without it
metrics-server never scrapes. That flag disables verification of the kubelet
certificate, which is why the file is local-only; a real cluster installs the
manifest unchanged.

This closes the gap `NOTES.md` previously listed as unresolved: the HPA
reported `<unknown>/70%` locally and could not be demonstrated. It is also now
a requirement rather than a nice-to-have, because the Deployment no longer
declares `replicas`.

## k8s/base/configmap.yaml

| Change | Why |
|---|---|
| `PG_POOL_MAX` 25 to 8 | `max_connections` is 100, fixed, and the data team will not raise it. 25 against `maxReplicas: 10` asks for 250. With `connectionTimeoutMillis` at 2s and no queue, exceeding it surfaces as 500s rather than backpressure. 8 x 10 = 80 leaves room for the superuser reserve and the migration connection. |
| Removed `LOG_FILE` | The disk exhaustion above. |
| Added `DEDUPE_MAX_ENTRIES` | Makes the cache bound explicit and tunable rather than a code default. |
| Added `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Environment-independent, so they belong in `base`. The sampler is config rather than code so the trace volume can be changed without a rebuild. |

## k8s/base/service.yaml

`targetPort: 3000` to `targetPort: http`. The third leg of the port mismatch.
Referencing the named port means it tracks the container definition.

## k8s/base/hpa.yaml

`minReplicas: 1` to `3`. A `minReplicas: 1` HPA would immediately scale the
deployment back down to one pod. With the `replicas` field now gone from the
Deployment, this is the only thing holding the floor.

## k8s/base/pdb.yaml (new)

`minAvailable: 2`. There was no PodDisruptionBudget, so a node drain or cluster
upgrade could evict every pod at once.

## k8s/ split into base/ and local/

`kubectl apply -f k8s/` was applying every file in the directory, including
`secret.yaml` and `postgres.yaml`. In the deploy job that meant production's
real Secret was overwritten with local placeholders and the single-replica
stand-in database was installed into the prod cluster on every deploy.

Nothing in the manifests tells you which files are safe to ship, so the
directory now says it:

| Path | Applied where |
|---|---|
| `k8s/base/` - namespace, configmap, deployment, service, hpa, pdb | Everywhere, including production |
| `k8s/local/` - `secret.yaml`, `postgres.yaml` | kind and CI only |

`make deploy` applies both. CI applies both, because it needs a database to
test against. The deploy workflow applies `base` only, so the mistake is no
longer possible to make by accident.

## Makefile

| Change | Why |
|---|---|
| `deploy` waits for metrics-server, then `ScalingActive` on the HPA, then `tools/wait-scaled.sh` | The HPA owns the replica count now, so a deploy is not finished when the rollout converges - it is finished when the HPA is actually scaling and the floor is met. |
| `deploy` waits on `rollout status` for postgres then relay | It returned success whether or not the rollout converged, which is the same reason the old CI job could not tell a failed deploy from a good one. It also fixes ordering, since relay's init container needs Postgres up. |
| Added a `smoke` target | One command to check the behaviour that matters. |
| `status` includes `pdb` | So the new object shows up in the standard view. |

## tools/wait-scaled.sh (new)

With no `replicas` field the Deployment is created at 1 and the HPA climbs to
`minReplicas`. `rollout status` is satisfied at 1/1, so without this the smoke
test could run against a single pod - and `tools/smoke.sh` only proves anything
about cross-pod replay behaviour when there is more than one pod. CI would have
gone green against the exact bug it exists to catch.

Reads `minReplicas` from the HPA rather than hardcoding 3, and checks
`readyReplicas` is at least that, so it still passes if the HPA has scaled
above the floor.

## tools/smoke.sh (new)

Asserts what no test covered and what actually changed: health and live both
200, first POST 201, ten replays 409 with a stable id, `GET /events/:id` 200,
missing header 400. Against a scaled deployment it fails on the old in-memory
dedupe, which is what makes it evidence rather than decoration.

## .gitignore

Added `.env`, which was never covered and is why the credentials were committed
in the first place, plus `.terraform/` and tfstate - `terraform init` pulls a
729 MB provider directory that must not land in the repo.

## terraform/.terraform.lock.hcl (new)

Committed so `terraform validate` is reproducible against the same provider
version. Related to, but not a fix for, the missing version constraint in
`main.tf`, which is a review finding.

## .github/workflows/deploy.yml

| Change | Why |
|---|---|
| `kubectl apply -f k8s/` to `-f k8s/base/` | See above. This is the one that would have taken production down on the first deploy after launch. |
| `:latest` to `:${{ github.sha }}` | You could not tell which commit was running, and there was no earlier image to roll back to. The tag is now the commit. |
| `rollout restart` to `kubectl patch` | `rollout restart` only existed because pushing the same tag does not change the pod spec. With a SHA tag the image change is the rollout. The patch updates the `migrate` init container too, so migrations run from the same build as the app. |
| Added `rollout status --timeout=10m` | The job went green the moment `rollout restart` was accepted, before a single new pod was Ready. A deploy that crash-looped reported success. |
| Added a `ScalingActive` gate on the HPA | The Deployment no longer declares `replicas`, so the HPA owns the count. A cluster with no metrics-server cannot scale at all, not even up to `minReplicas`, and would run production on one pod with a green deploy. This turns that into a failed deploy. |
| `set image` and a `change-cause` annotation in one `kubectl patch` | `rollout history` is what you read to pick a revision to go back to, and it was blank. Doing it as two calls relabels the revision that is already there, so the same commit appears twice; one patch puts the annotation on the new ReplicaSet only. |
| `actions/checkout@master`, `configure-aws-credentials@master` to pinned SHAs | Mutable refs on third-party actions in a job that holds production AWS credentials. Whoever controls those branches could have run code in that context. |
| Long-lived AWS keys to OIDC `role-to-assume` | `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` never expire and nobody rotates them. With OIDC there is no standing credential in the repo. |
| Added `permissions: contents: read` | The workflow inherited the org default, which on older repos is write-all on `GITHUB_TOKEN`. |
| Added `environment: production` | A push to main reached production with no approval and no deployment record. |
| Added `concurrency: deploy-production`, `cancel-in-progress: false` | Two pushes in quick succession raced each other. Deploys queue rather than cancel - killing a run mid-apply leaves the cluster halfway through a change with nothing to say which half. |
| Replaced the hand-rolled ECR login with `amazon-ecr-login` | The `docker login` pipeline had no `--region` and failed silently on a token refresh. |
| Added `workflow_dispatch` | So a deploy can be re-run without an empty commit. |

There is deliberately no automatic rollback on failure. A bad image never takes
traffic - the readiness probe holds it out of the Service and `maxUnavailable`
keeps the old pods serving - so a failed `rollout status` means the rollout
stalled, which is already the safe state. Undoing it there would tear down the
crash-looping pods you need the logs from, and it would fire on a rollout that
was only slower than the timeout. Rollback is a decision someone makes, which
is what `rollback.yml` is for.

## .github/workflows/ci.yml (new)

Nothing ran on a pull request. `main` was the first place any code was tested,
and the only thing it did there was deploy it.

Four jobs, each its own check so a red tick says what broke:

| Job | What it does |
|---|---|
| `app` | `npm ci` against the lockfile, `node --check` on every source file, `npm audit --audit-level=high` on production deps |
| `e2e` | Builds the image, brings up the real three-node kind cluster, applies `base` and `local`, runs `tools/smoke.sh`. Dumps pod state and logs on failure |
| `image` | Trivy on the built image, failing on HIGH and CRITICAL with `ignore-unfixed` so it blocks on things that can actually be patched |

`cancel-in-progress: true` here, grouped per ref: a superseded run on the same
branch is worth nothing, so killing it just returns runner minutes. That is the
opposite of the deploy job and deliberately so.

The `app` job is not a test suite - there is no test suite, and a real one
needs a database fixture. `e2e` is the behavioural gate, and it fails against
the old in-memory dedupe as soon as there is more than one pod.

## .github/workflows/terraform.yml (new)

Was a job inside `ci.yml`. Split out because it has nothing in common with the
other three: it touches no application code, needs no Docker and no cluster,
and only has anything to say when `terraform/` changes.

As its own workflow it carries `paths: ['terraform/**']`, so it does not run on
the majority of pull requests that do not touch infrastructure, and it gets its
own status check rather than hiding inside a pass or fail that was really about
the app. `workflow_dispatch` is there so it can be run by hand after a provider
release without an empty commit.

One consequence worth knowing: a path-filtered workflow reports nothing at all
on a PR that does not touch `terraform/`. If it is ever made a required status
check, those PRs will wait forever for a check that is never going to run.

## .github/workflows/rollback.yml (new)

The failure the pipeline could not handle was a deploy that goes green and
starts failing twenty minutes later. Nothing in the repo turned that around;
you needed someone with cluster credentials on their laptop.

`workflow_dispatch` with an optional revision - blank means the previous one -
and a required reason that lands in the run record. It prints the history and
the running image before and after, waits on `rollout status`, and never
touches the repo: no checkout, nothing but `kubectl rollout undo`.

It shares the `deploy-production` concurrency group so a rollback and a deploy
can never touch the cluster at once, but with `cancel-in-progress: true`, which
is the one place cancelling is right. A deploy sitting in `rollout status` would
otherwise make an operator wait up to ten minutes to roll back, and the thing
being cancelled is the deploy they are rolling back anyway.

## docs/SCALING.md (new)

Who owns the replica count and why the Deployment does not declare it, what
the CPU request has to do with the HPA target, and the empirical result that
an HPA with no metrics cannot scale even up to `minReplicas`. That last one is
the opposite of what most people assume, which is why it is written down with
the output rather than asserted.

Also records what is still unverified: the HPA has never been seen scaling
under real CPU load, so `70` as a target and the default scale-down
stabilisation are both untested numbers.

## docs/OBSERVABILITY.md (new)

How the telemetry is wired, what arrives, and the four alerts to create with
the reasoning behind each threshold. Alerts are SigNoz-side objects, so they
cannot be committed; the queries can be.

Also states plainly what is unverified: the hop from collector to SigNoz Cloud.
The app side was checked against a real collector in the cluster.

## Not changed

`terraform/` is review-only per the brief, so all of its findings are written
up in `NOTES.md` rather than fixed. `k8s/local/postgres.yaml` is out of scope.
