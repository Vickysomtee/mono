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
now, and `migrate.js` takes an advisory lock, wraps each migration with its
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
capabilities. The image went from about 1.1 GB to 262 MB.

## What I found and left

**The CI pipeline.** `actions/checkout@master` and
`configure-aws-credentials@master` are mutable refs on third-party actions in a
job holding production AWS credentials — pin to SHAs and move to OIDC. More
urgently, `kubectl apply -f k8s/` applies `secret.yaml` and `postgres.yaml` to
production on every deploy, so it overwrites the real secrets with the local
placeholders and installs the local stand-in database into the prod cluster.
There is also no test, no scan, no `rollout status` gate, and `:latest` means
nothing is traceable or rollback-able. I left it because it is a rewrite, not a
patch, and I would rather agree the approach first.

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

**No metrics or alerts.** The biggest remaining gap and I could not close it
honestly on kind — there is no metrics-server, which is also why the HPA still
shows `<unknown>` locally. The app needs a `/metrics` endpoint with RED metrics
on `/events` plus a pool-saturation gauge, because pool saturation is the
failure mode I would expect first.

**No real test suite.** `make smoke` covers the behaviour I changed. A proper
suite needs a database fixture, which is more than I wanted to add this week.

**The signature.** HMAC over `JSON.stringify(payload)` is key-order dependent,
so a client that re-serialises differently gets a different signature. Nothing
verifies an incoming signature either, so it is a storage tag, not
authentication. Left it because changing it invalidates every stored signature
and that needs a conversation.

**`k8s/postgres.yaml`** is out of scope, but it caused the only stall I saw. At
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
2. **The CI deploy job stops applying `secret.yaml` and `postgres.yaml` to
   production.** As written, the first deploy after launch overwrites
   production secrets with local placeholders. *Me, needs an hour.*
3. **Written confirmation of the connection budget from the data team**, and
   an answer on 400 vs 150 rps, because the pool maths depends on it.
4. **The Terraform blockers above fixed before the first `apply`.** It has
   never been applied, so Friday is the first time anyone finds out what it
   really does. I would not discover that on launch day. *Me plus security.*
5. **Metrics and four alerts live** — 5xx rate, p99 latency, pool saturation,
   CrashLoopBackOff/OOMKill — with someone on call. *Platform.*

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
