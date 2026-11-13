# Changes

Every change in this branch, file by file, with the reason. 17 files,
+532/-92. `NOTES.md` has the ship call and the load test evidence; this is the
line-by-line companion to it.

Changes marked **Blocker** are the ones that stopped `make up` producing a
working service.

## app/Dockerfile

| Change | Why |
|---|---|
| `COPY package.json .` to `COPY package.json package-lock.json ./` | **Blocker.** `npm ci` refuses to run without a lockfile, so the build failed before anything else could be reached. |
| `FROM node:22` to `node:22-slim` | The full Debian image is about 1.1 GB with a large CVE surface. The image is now 262 MB. |
| `COPY . .` + `RUN rm -f .env` to `COPY src ./src` | The old form copied `.env` into a layer and deleted it in a later one. Deleted files stay readable in the earlier layer, so the staging password shipped inside any image pushed to ECR. |
| Added `USER node` | The container ran as root. Nothing needs root at runtime. |
| `EXPOSE 3000` to `8080` | Simply wrong, and misleading to the next person. |
| `ENTRYPOINT ["sh", "./entrypoint.sh"]` to `CMD ["node", "src/server.js"]` | `sh` became PID 1 and npm does not forward signals, so SIGTERM never reached node and every pod was SIGKILLed after the grace period with requests in flight. |
| `--max-old-space-size=512` to `384` | The heap was above the 256Mi container limit, so the kernel killed the container before V8 had any reason to collect. Raising this is what the previous owner did about the OOMs, and it made them worse. |

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

## app/src/config.js

| Change | Why |
|---|---|
| `port` default 3000 to 8080 | The contract is 8080 everywhere. A default that contradicts it invites the mismatch that broke this deploy. |
| `poolMax` default 25 to 8 | See the connection budget under `k8s/configmap.yaml`. |
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

## k8s/deployment.yaml

### Blockers

| Change | Why |
|---|---|
| `secretKeyRef.key: database-url` to `DATABASE_URL` | The Secret defines `DATABASE_URL` and keys are case-sensitive. The pod never left `CreateContainerConfigError`. |
| `containerPort: 3000` to `name: http, containerPort: 8080` | `PORT` was already 8080 in the ConfigMap, so the app listened there while Kubernetes probed and routed to 3000. Naming the port means the Service and probes reference the name and cannot drift again. |
| Added `imagePullPolicy: IfNotPresent` to both containers | A `:latest` tag makes the kubelet default to `Always`, so it ignored the image `kind load` had just put on the node and tried to pull from Docker Hub. |
| Added the `migrate` init container | Moves migrations out of the app container, running once before the app against the same image. |

### Capacity and availability

| Change | Why |
|---|---|
| `replicas: 1` to `3` | One replica is a single point of failure for a launch, and scaling up from one is slow. |
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

## k8s/configmap.yaml

| Change | Why |
|---|---|
| `PG_POOL_MAX` 25 to 8 | `max_connections` is 100, fixed, and the data team will not raise it. 25 against `maxReplicas: 10` asks for 250. With `connectionTimeoutMillis` at 2s and no queue, exceeding it surfaces as 500s rather than backpressure. 8 x 10 = 80 leaves room for the superuser reserve and the migration connection. |
| Removed `LOG_FILE` | The disk exhaustion above. |
| Added `DEDUPE_MAX_ENTRIES` | Makes the cache bound explicit and tunable rather than a code default. |

## k8s/service.yaml

`targetPort: 3000` to `targetPort: http`. The third leg of the port mismatch.
Referencing the named port means it tracks the container definition.

## k8s/hpa.yaml

`minReplicas: 1` to `3`. A `minReplicas: 1` HPA would immediately scale the
deployment back down to one pod.

## k8s/pdb.yaml (new)

`minAvailable: 2`. There was no PodDisruptionBudget, so a node drain or cluster
upgrade could evict every pod at once.

## Makefile

| Change | Why |
|---|---|
| `deploy` waits on `rollout status` for postgres then relay | It returned success whether or not the rollout converged, which is the same reason the CI job cannot tell a failed deploy from a good one. It also fixes ordering, since relay's init container needs Postgres up. |
| Added a `smoke` target | One command to check the behaviour that matters. |
| `status` includes `pdb` | So the new object shows up in the standard view. |

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

## Not changed

`terraform/` is review-only per the brief, so all of its findings are written
up in `NOTES.md` rather than fixed. `k8s/postgres.yaml` is out of scope.
`.github/workflows/deploy.yml` is untouched and its findings are in `NOTES.md`
- the two that would bite first are the `@master` refs on actions holding
production AWS credentials, and `kubectl apply -f k8s/` applying `secret.yaml`
and `postgres.yaml` to production, which overwrites the real secrets with the
local placeholders.
