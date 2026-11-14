SHIP WITH CONDITIONS

I got it running, fixed what would have broken at launch traffic, and reviewed
the Terraform without applying it. The conditions below are not polish, they
are things I think have to be true before Friday.

Load test, 400 rps for 5 minutes, 8 KB payloads, 5% replays, against 3 pods:

```
total: sent=119991 status[201:114103 409:5888] errors[-] p50=12ms p95=17078ms p99=19016ms
```

119,991 requests, zero errors, every 5-second window holding a steady 2,000.
The p50 is the steady-state number; the p95 is one 25-second pause at t=175s,
which was the local stand-in database checkpointing onto an `emptyDir`, not
relay. Outside that window p95 sat between 14 and 48ms.

## What I changed

**Got it to start.** Three separate things stopped it.

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

**Connection budget.** The database caps at 100 and the data team will not
raise it. `PG_POOL_MAX` was 25 against `maxReplicas: 10`, which asks for 250.
With `connectionTimeoutMillis` at 2s and no queue, exceeding it surfaces as
500s rather than backpressure. Now 8, so 8 x 10 = 80 at full scale. The 25%
`maxSurge` default would have added three more pods during a deploy and taken
that to 104, so the Deployment pins `maxSurge: 1` and tops out at 89 including
the migration connection.

**HPA could not scale.** Scaling on CPU utilisation also needs a CPU
request and only `limits.memory` was set, so it reported `<unknown>` and sat at
one replica. I added `requests.cpu: 250m`, raised the floor to 3, and added a
PDB so a node drain cannot take it below 2.

**Added a metrics-server deployment.** An HPA with no metrics cannot scale
**at all**: the HPA reported `AbleToScale: True` and `ScalingActive: False`. So
a cluster without metrics-server does not autoscale, because the HPA depends on
it for the scaling metrics.

**Probes were one database blip away from a full outage.** `/health` queries
the database and liveness pointed at it with `failureThreshold: 2` and
`periodSeconds: 5`. One slow database moment fails every pod inside 10 seconds
and restarts the entire deployment at once. Liveness now hits `/live`, which
only proves the process is up. Readiness keeps the database check, because that
is what should gate traffic. Added a startup probe.

**Migrations.** Every replica ran them on boot with no locking, so more than
one pod meant pods racing the same `ALTER TABLE`. They are an init container
now, behind a second one that waits on `pg_isready` so a cold cluster does not
crash-loop the migration while the database is still coming up, and
`migrate.js` takes an advisory lock, wraps each migration with its
version row in one transaction, and builds the unique index `CONCURRENTLY` so
it does not hold `ACCESS EXCLUSIVE` on `events`.

**Logging.** `LOG_FILE` wrote to `/var/log/relay` inside the container with no
volume and no rotation, so it grew on the node's disk until eviction, and
`kubectl logs` showed nothing. Access logs now directly go to stdout.

**S3 archive was in the request path.** Awaited before the 201, so a slow
bucket showed up directly in client latency, and an S3 error returned 500 for
an event that was already committed — the client then retries something we
stored. It runs after the response now.

**Credentials.** `app/.env` held a staging database password and the signing
secret, `.gitignore` never covered `.env`, and the Dockerfile copied it in and
`rm`'d it in a later layer, which leaves it readable in the image to anyone who
can pull from ECR. It is kept out of this repo's history entirely and
`.dockerignore` keeps it out of the image.

Container is non-root on `node:22-slim` with a read-only root filesystem, built
in multiple stages. The image went from about 1.1 GB to 288 MB. npm is deleted
from the runtime stage.

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

Rollback is manual, in `rollback.yml`: `workflow_dispatch` with an optional
revision and a required reason, in the deploy concurrency group so the two
cannot race. I left it manual because a bad image never takes traffic -
readiness holds it out of the Service and `maxUnavailable` keeps the old pods
up - so a stalled rollout is already the safe state, and undoing it destroys
the pods you need the logs from. What the workflow covers is the case probes
cannot: a deploy that went green and started failing later.

`ci.yml` runs on pull requests, which is the check this repo most needed. It
builds the image, brings up kind, and runs `make smoke` against three pods,
plus `npm audit` and Trivy. It cancels superseded runs, the opposite of the
deploy job and deliberate: a superseded PR run is wasted minutes, a superseded
deploy is a half-applied cluster.

**Telemetry.** OpenTelemetry over OTLP to SigNoz Cloud, written up in
`docs/OBSERVABILITY.md`. `http.server.request.duration` by route and status is
the whole of the RED ask - rate, p95, p99, error rate and which endpoint is
erroring. Metrics go out unsampled and traces at 10%, because deriving the rate
from sampled spans reports a tenth of the real traffic.

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
2. **Confirmation that the cap is really 100.** Eight per pod is generous -
   the load test held 400 rps on nine connections - but eight across
   `maxReplicas: 10` is 80, and 89 during a deploy. That fits, with whatever
   the database reserves for superusers coming out of the same 100. It also
   means `maxReplicas` cannot rise, and nothing else can share this database,
   without redoing the sum. The database is not in the Terraform, so the
   number is one I am taking on trust. If it cannot move, PgBouncer is the
   fix: one pooler holding a few backend connections, so adding pods stops
   costing any. *Data team.*
3. **A secret manager.** The database credentials are a Kubernetes Secret,
   which is base64, not encryption - anyone who can read Secrets in the
   namespace can decode them. Standard practice is a real secret manager:
   Vault, Infisical or Doppler.

## Questions I would have asked

1. **Is peak 400 rps or 150?** The README says 400, the handoff says 150, and
   the load tool defaults to 150. I sized for 400. Nearly every capacity
   decision moves if that is wrong.
