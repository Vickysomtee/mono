# Handoff notes — relay

Writing this up before I move teams. Sorry it's brief.

## What it is

Small Node service. Clients POST events to `/events` with an `Idempotency-Key`
header, we sign and store them in Postgres. Clients retry aggressively with the
same key, so a `409` on a replay is expected and correct.

## Where things stand

- It has been running in staging at 1 replica for weeks with no real issues.
- Staging was clicked together by hand. The Terraform in `terraform/` is what
  production is supposed to be built from. It has never been applied.
- Health checks are configured.
- Autoscaling is set up, 1–10 pods.
- Deploys are zero-downtime since Kubernetes does rolling updates by default.
- We saw a couple of out-of-memory restarts in staging, so I bumped the Node
  heap to 512 MB. Haven't seen it since, but staging traffic is tiny.

## Production facts

- Expected peak is about 150 requests per second, payloads up to 8 KB.
- The database is managed Postgres owned by the data team. `max_connections`
  is 100 and they have said they will not raise it this quarter.
- The container has to listen on 8080 in every environment. The platform
  team's network policy only allows that port and they won't change it before
  launch.
- In production the pods also archive each payload to S3 (`ARCHIVE_BUCKET`).
  No keys needed, it works through the node role.
- The ALB sits in front of the cluster and forwards to the service's NodePort.

## Not done

- CI works but I never got round to tidying it.
- No dashboards or alerts yet.
