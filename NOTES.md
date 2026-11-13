SHIP WITH CONDITIONS

I got it running, fixed what would have broken at launch traffic, and reviewed
the Terraform without applying it. The conditions below are not polish, they
are things I think have to be true before Friday.

Load test, 400 rps for 5 minutes, 8 KB payloads, 5% replays, against 3 pods:

```
total: sent=119991 status[201:114103 409:5888] errors[-] p50=12ms p95=17078ms p99=19016ms
```

119,991 requests, zero errors, every 5-second window holding a steady 2,000.
The p50 of 12ms is the real steady-state number and the p95 is not: the service
paused for about 25 seconds around t=175s and then drained the backlog. That
pause was the local stand-in database, not relay, and the evidence is in the
"what I left" section below. Outside that window p95 sat between 14 and 48ms.

I am quoting this run rather than a prettier one because it is the only one
that sustained a true 400 rps for the full five minutes. Running the generator
inside the cluster to rule out Docker Desktop's port-forward gave
`sent=59604 ... p50=8ms p95=46ms p99=429ms` with zero errors, but it was
CPU-starved against the pods it was testing and never reached the target rate,
so I am treating it as a cross-check on latency only.

## What I changed

**Got it to start.** Three separate things stopped it, all in commit 2:

- `npm ci` needs the lockfile and the image never copied it, so the build
  failed before anything else could.
- The Secret keys are `DATABASE_URL`/`SIGNING_SECRET`, the Deployment asked for
  `database-url`. Pod never left `CreateContainerConfigError`.
- `PORT` is 8080 in the ConfigMap, but `containerPort`, the probe and the
  Service `targetPort` all still said 3000, so nothing reached the app.

`:latest` also needs `imagePullPolicy: IfNotPresent` or the kubelet ignores the
image `kind load` just put on the node and tries to pull it.

**Replays now resolve against the database.** This is the one I would defend
first. Dedupe was a per-process `Map`, which only works at the one replica
staging ran. A retry landing on a pod that has not seen the key inserts, trips
the unique index, falls into the generic `catch` and returns **500**. The
handoff says a replay is a 409, and these clients retry hard on anything else,
so the bug amplifies under exactly the traffic it exists to absorb. The index is
the source of truth now, via `ON CONFLICT DO NOTHING RETURNING id`.

How I saw it: same `Idempotency-Key`, 12 requests, 3 replicas.

```
201 409 409 409 409 409 409 409 409 409 409 409
relay-...-6tfcz: 2 requests
relay-...-b9qdj: 5 requests
relay-...-gm7zm: 5 requests
```

All three pods served that key and all three agreed on the id. `make smoke`
asserts this and fails against the old code once you scale past one pod.

The same `Map` was also an unbounded leak: `DEDUPE_MAX_ENTRIES` defaulted to 0
meaning "no limit" and it held the whole 8 KB payload per key. At 400 rps that
is roughly 3 MB/s retained against a 256 Mi limit. That is the OOM in the
handoff. Raising the heap to 512 MB made it worse, not better, because the
limit was 256 Mi, so the kernel killed the container before V8 had any reason
to collect.

**Connection budget.** The database caps at 100 and the data team will not
raise it. `PG_POOL_MAX` was 25 against `maxReplicas: 10`, which asks for 250.
With `connectionTimeoutMillis` at 2s and no queue, exceeding it surfaces as
500s rather than backpressure. Now 8, so 8 x 10 = 80 with room for the
superuser reserve and the migration connection.

**The HPA could never have worked.** Scaling on CPU utilisation needs a CPU
request and only `limits.memory` was set, so it reported `<unknown>` and sat at
one replica. "Autoscaling is set up, 1-10 pods" was not true. Added requests,
raised the floor to 3, added a PDB so a node drain cannot take it below 2.

**Probes were one database blip away from a full outage.** `/health` queries
the database and liveness pointed at it with `failureThreshold: 2` and
`periodSeconds: 5`. One slow database moment fails every pod inside 10 seconds
and restarts the entire deployment at once. Liveness now hits `/live`, which
only proves the process is up. Readiness keeps the database check, because that
is what should gate traffic. Added a startup probe.

**Deploys were not zero-downtime.** `sh` was PID 1 and npm does not forward
signals, so SIGTERM never reached node and every pod was SIGKILLed after the
grace period with requests in flight. The image execs node directly now and the
process drains the listener and the pool, reporting `draining` from `/health`
first so it leaves rotation before the socket goes.

**Migrations.** Every replica ran them on boot with no locking, so more than
one pod meant pods racing the same `ALTER TABLE`. They are an init container
now, behind a second one that waits on `pg_isready` so a cold cluster does not
crash-loop the migration while the database is still coming up, and
`migrate.js` takes an advisory lock, wraps each migration with its
version row in one transaction, and builds the unique index `CONCURRENTLY` so
it does not hold `ACCESS EXCLUSIVE` on `events`. Migration 3 would also have
failed outright if staging already had duplicate keys — worth checking before
this runs anywhere real.

**Logging.** `LOG_FILE` wrote to `/var/log/relay` inside the container with no
volume and no rotation, so it grew on the node's disk until eviction, and
`kubectl logs` showed nothing. Access logs go to stdout.

**S3 archive was in the request path.** Awaited before the 201, so a slow
bucket showed up directly in client latency, and an S3 error returned 500 for
an event that was already committed — the client then retries something we
stored. It runs after the response now.

**Credentials.** `app/.env` held a staging database password and the signing
secret, `.gitignore` never covered `.env`, and the Dockerfile copied it in and
`rm`'d it in a later layer, which leaves it readable in the image to anyone who
can pull from ECR. It is kept out of this repo's history entirely and
`.dockerignore` keeps it out of the image. Both values still need rotating —
whatever this repo does, they have already been sitting in a shared archive.

Container is non-root on `node:22-slim` with a read-only root filesystem and no
capabilities. The image went from about 1.1 GB to 258 MB. npm is deleted from
the runtime stage - nothing shells out to it, and the copy the base image ships
was the source of all 10 HIGH findings Trivy raised. The app's own dependencies
are clean.

**CI.** The deploy job ran `kubectl apply -f k8s/`, which includes
`secret.yaml` and `postgres.yaml`. Every deploy overwrote production's real
Secret with local placeholders and installed the single-replica stand-in
database into the prod cluster. `k8s/` is split into `base/` and `local/` now
and the job applies `base` only.

The rest of that job: `actions/checkout@master` and
`configure-aws-credentials@master` were mutable refs on third-party actions in
a step holding production AWS credentials, so they are pinned to SHAs and the
credentials are OIDC now. `:latest` meant nothing was traceable or
rollback-able, and `rollout restart` only existed to work around pushing the
same tag — the image is tagged with the commit SHA and a single
`kubectl patch` does the rollout. Nothing gated on the result, so the job reported success
before a single new pod was Ready; it waits on `rollout status` now, and
records the commit as the revision's change-cause so `rollout history` is
readable. Added a `permissions` block, a `production` environment, and
`concurrency` that queues rather than cancels, because killing a run mid-apply
leaves the cluster halfway through a change.

It does not roll back on its own. A bad image never takes traffic, because
readiness holds it out of the Service and `maxUnavailable` keeps the old pods
up, so a stalled rollout is already the safe state and undoing it just destroys
the pods you need the logs from. The case that actually needed an answer is a
deploy that goes green and starts failing later, and that is `rollback.yml`:
`workflow_dispatch`, an optional revision, a required reason, sharing the
deploy concurrency group so the two cannot race.

Nothing ran on a pull request at all, which is the part I would fix first in
any repo. `ci.yml` builds the image, brings up kind, and runs `make smoke`
against three pods, plus `npm audit`, `terraform validate` and Trivy. That one
cancels superseded runs, which is the opposite of the deploy job and
deliberate.

**Telemetry.** OpenTelemetry over OTLP to SigNoz Cloud, written up in
`docs/OBSERVABILITY.md`. `http.server.request.duration` by route and status is
the whole of the RED ask - rate, p95, p99, error rate and which endpoint is
erroring. Metrics go out unsampled and traces at 10%, because deriving the rate
from sampled spans reports a tenth of the real traffic.

Two things fell out of it that I would otherwise have written by hand. The `pg`
instrumentation exports `db.client.connection.pending_requests` and `.max`, so
pool saturation - the failure mode I said I expected first - is covered without
custom code, and `max` reads 8, matching `PG_POOL_MAX`. And a `POST /events`
span carries the insert underneath it, which is the view that would have
answered the 25 second stall in minutes instead of an afternoon in Postgres
logs.

Alerts are SigNoz-side objects, so the four from the conditions below are
written up as queries and thresholds rather than committed. Export to SigNoz
Cloud itself is unverified: what I checked is that the app emits those metrics
and spans, with those attributes, against a real collector in the cluster. The
collector-to-SigNoz hop is an endpoint and a key.

I also checked what happens when the backend is down. Collector scaled to zero:
requests and the smoke test all passed, zero restarts. An observability outage
does not become a relay outage.

That one needed a fix, though. The SDK reports export failures only at its debug
level, which also logs a line per request, so a wrong endpoint or a rejected key
looked exactly like working telemetry. Each exporter now logs one line when it
starts failing and one when it recovers, verified both ways:

```
telemetry: trace export failing: connect ECONNREFUSED 10.96.251.236:4318
telemetry: metric export failing: connect ECONNREFUSED 10.96.251.236:4318
telemetry: trace export recovered
telemetry: metric export recovered
```

## What I found and left

**Terraform** is review-only per the brief, so this is a list, not a diff.
`terraform init -backend=false && terraform validate` passes.

Would block a launch:
- `var.db_password` defaults to a production password in version control, not
  marked `sensitive`.
- No backend block, so state is local, unlocked, and holds that password in
  plaintext.
- No provider version constraint at all — the next `init` can pull a major.
- `aws_security_group.nodes` allows SSH from `0.0.0.0/0` ("SSH for debugging"),
  and the bastion SG does too, which makes the bastion pointless.
- Node role has `s3:*` + `secretsmanager:*` on `*`, inherited by every pod,
  with IMDSv1 still enabled (`http_tokens = "optional"`) and a hop limit of 2.
  One SSRF in the app is full S3 and full Secrets Manager. Should be IRSA with
  a bucket-scoped policy.
- EKS public endpoint open to `0.0.0.0/0`; nodes in public subnets with
  `map_public_ip_on_launch`; ALB is HTTP/80 with no TLS.

Would not work if applied:
- The target group is on port 30080 but the node SG only allows 8080 from the
  ALB, so health checks never pass and the ALB serves 502s.
- `aws_autoscaling_attachment` against an EKS-managed node group fights the
  node group's own lifecycle. This wants the AWS Load Balancer Controller.
- `ami-0c55b159cbfafe1f0` is a hardcoded us-east-1 AMI being used in eu-west-1.
- Node group is pinned to one subnet, so there is no AZ redundancy regardless
  of what the topology spread constraint says.

Also: EBS unencrypted, archive bucket has no public access block, versioning,
encryption or lifecycle policy, and nothing is tagged.

**No metrics-server on kind**, which is why the HPA still shows `<unknown>`
locally. That is a kind limitation rather than a repo defect - the real defect,
a missing CPU request, is fixed.

**No real test suite.** `make smoke` covers the behaviour I changed. A proper
suite needs a database fixture, which is more than I wanted to add this week.

**The signature.** HMAC over `JSON.stringify(payload)` is key-order dependent,
so a client that re-serialises differently gets a different signature. Nothing
verifies an incoming signature either, so it is a storage tag, not
authentication. Left it because changing it invalidates every stored signature
and that needs a conversation.

**`k8s/local/postgres.yaml`** is out of scope, but it caused the only stall I saw. At
400 rps the service paused about 25 seconds around t=175s and then drained the
backlog with no errors. The cause was the local stand-in checkpointing onto an
`emptyDir`:

```
checkpoint complete: wrote 8406 buffers (51.3%); write=873.548 s, distance=540667 kB
events: 153511 rows, 1357 MB
connections: 9 of 100
```

That is a laptop artifact rather than a relay bug — 9 connections of 100 and
zero application errors — but it is worth confirming the managed instance's
checkpoint and IO settings, because the write volume is real. 400 rps at 8 KB
is about 3 MB/s before indexes, so roughly 250 GB a day. Nobody has mentioned
retention.

## Friday

Ship with conditions. The service itself I am now comfortable with: it holds
400 rps with no errors, replays behave, it drains cleanly and it restarts
without losing requests. What I am not comfortable with is everything around
it.

Conditions, in the order I would chase them:

1. **TLS on the ALB and authentication on both endpoints.** `GET /events/:id`
   returns full stored payloads with no auth, behind an internet-facing
   listener on plain HTTP. This is the one that would change my answer to do
   not ship. *Platform, plus me.*
2. **Someone creates the `relay-deploy` IAM role, the `production`
   environment, and the production `relay-env` ConfigMap.** The pipeline
   expects OIDC and an approval gate; neither exists yet, so the first push to
   main fails at the credentials step until they do. `relay-env` carries the
   SigNoz endpoint, and without it the pods start with telemetry silently off.
   *Platform, needs an hour.*
3. **Written confirmation of the connection budget from the data team**, and
   an answer on 400 vs 150 rps, because the pool maths depends on it.
4. **The Terraform blockers above fixed before the first `apply`.** It has
   never been applied, so Friday is the first time anyone finds out what it
   really does. I would not discover that on launch day. *Me plus security.*
5. **The four alerts in `docs/OBSERVABILITY.md` created, and someone on
   call.** The metrics they need are arriving; the alerts are not created and
   the restart alert also needs the SigNoz k8s-infra chart installed, which is
   a separate job from instrumenting the app. *Platform.*

If 1, 2 and 5 are not done by Thursday, this is a do not ship for me. They are
all a day's work, which is why the answer is conditions rather than no.

## Questions I would have asked

1. **Is peak 400 rps or 150?** The README says 400, the handoff says 150, and
   the load tool defaults to 150. I sized for 400. Nearly every capacity
   decision moves if that is wrong.
2. **Is `max_connections = 100` really immovable?** It is the binding
   constraint on how far this scales. If it cannot move, I would rather put
   PgBouncer in now than discover the ceiling during launch.
3. **Who owns TLS termination and the auth story, and does anything already
   exist?** I do not want to invent a scheme if the platform team has one.
4. **Does anyone consume the S3 archive, and does it need to be complete?** It
   is fire-and-forget now. If a gap is a compliance problem it needs an outbox,
   which is a bigger change.
5. **Has the staging database got duplicate `idempotency_key` rows?** If so the
   unique index migration fails on first run and I would want to know before it
   runs against production.
6. **What is the retention policy on `events`?** At 400 rps this is roughly
   250 GB a day and nobody has said what happens to it.
7. **Where does the image actually go?** The deploy job pushes to
   `123456789012.dkr.ecr.eu-west-1.amazonaws.com/relay`, which is a placeholder
   account, and nothing in `terraform/` creates an ECR repository. I kept the
   value so the diff stays readable, but it and `secrets.AWS_DEPLOY_ROLE_ARN`
   both need filling in before the first deploy.
