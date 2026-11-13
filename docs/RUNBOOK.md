# Runbook

Getting relay running on a local kind cluster, from nothing.

## Before you start

| Need | Check | Notes |
|---|---|---|
| Docker, running | `docker info` | kind runs the cluster as containers, so the daemon has to be up first |
| kind | `kind version` | |
| kubectl | `kubectl version --client` | |
| Node 22+ | `node -v` | Only for `make loadtest` and local dev. The container ships its own Node |

Terraform is only needed if you want to run `terraform validate`; the service
does not need it.

If `node -v` shows anything below 22, use nvm rather than fighting a system
install: `nvm install 22 && nvm use 22`.

## The short version

```sh
make up
make smoke
```

`make up` is `cluster` then `build` then `load` then `deploy`. On a cold
machine expect **three to five minutes**, most of it pulling images:
`kindest/node`, `postgres:16-alpine`, `otel/opentelemetry-collector-contrib`
and `metrics-server`. It is not hung.

`make smoke` should print `PASS`.

## What each step does

```sh
make cluster   # kind create cluster --config kind-config.yaml
make build     # docker build -t relay:latest app
make load      # kind load docker-image relay:latest --name relay
make deploy    # kubectl apply, then wait for everything to be real
```

Run them individually if `make up` is interrupted — every step is idempotent,
so re-running costs nothing.

**The cluster** is three nodes: one control-plane and two workers labelled
`topology.kubernetes.io/zone=local-a` and `local-b`, so the Deployment's
topology spread constraint has something to spread across. The control-plane
maps container port 30080 to host port 8080, which is how
`http://localhost:8080` reaches the Service's NodePort.

**`make load` is not optional.** The image is `relay:latest` with
`imagePullPolicy: IfNotPresent`, so the kubelet uses the copy `kind load` puts
on the nodes. Skip it and the pods try to pull `relay:latest` from Docker Hub
and fail.

**`make deploy`** applies the namespace, then `k8s/local/`, then `k8s/base/`,
in that order, so Postgres and metrics-server are running before the relay
Deployment and its HPA appear. It then waits for four things, and the last two
are the ones that matter:

```
rollout status  metrics-server
rollout status  postgres
rollout status  relay
wait            hpa/relay ScalingActive     # the HPA can actually see CPU
tools/wait-scaled.sh                        # the HPA has reached minReplicas
```

The Deployment has no `replicas` field, so it is created at 1 and the HPA
climbs to 3. Those last two waits are why you get three pods rather than one.

## Checking it

```sh
make status     # deploy, pods, svc, hpa, pdb
make logs       # last 100 lines from all relay pods, prefixed with the pod
make smoke      # health, live, create, 10 replays, read, missing header
```

`make status` on a healthy cluster: 3/3 relay pods Running with 0 restarts,
`hpa/relay` showing a real percentage rather than `<unknown>`, and the PDB
reporting `ALLOWED DISRUPTIONS 1`.

Replays are the thing worth checking by hand, because they are what was broken:

```sh
KEY="demo-$(date +%s)"
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:8080/events \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" -d '{"a":1}'
done; echo
```

Expect `201 409 409 409 409 409 409 409 409 409 409 409`, whichever pod
answers each one. The key has to be fresh, which is what the timestamp is for
-- reuse one and you get twelve 409s, because the first request already stored
it.

## Load

```sh
make loadtest                          # 150 rps for 5 minutes
make loadtest RPS=400 DURATION=120     # what the README's peak looks like
```

Needs Node 22 on the host. It prints a line per 5-second window and a total.
`errors[-]` means none. At 400 rps the local Postgres on an `emptyDir` becomes
the bottleneck before relay does, so a p99 spike there is the laptop rather
than the service.

## After a code change

`make deploy` alone will not pick up a new image, because the tag has not
changed:

```sh
make build load
kubectl -n relay rollout restart deploy/relay
kubectl -n relay rollout status deploy/relay
```

Manifest-only changes just need `make deploy`.

## Telemetry

Off unless an endpoint is configured. By default `k8s/local/relay-env.yaml`
points at the in-cluster collector, which prints what it receives:

```sh
kubectl -n relay logs deploy/otel-collector --tail=50
```

To send to SigNoz Cloud instead, without putting a key in the repo:

```sh
kubectl -n relay patch configmap relay-env --type merge \
  -p '{"data":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://ingest.<region>.signoz.cloud"}}'

kubectl -n relay patch secret relay-secrets --type merge \
  -p '{"stringData":{"OTEL_EXPORTER_OTLP_HEADERS":"signoz-ingestion-key=<key>"}}'

kubectl -n relay rollout restart deploy/relay
```

Then watch for trouble. Silence is good:

```sh
kubectl -n relay logs -l app=relay -c relay --tail=200 | grep -i telemetry
```

`telemetry exporting to <endpoint>` only means the SDK started. A bad endpoint
or rejected key shows up as `telemetry: trace export failing: <reason>`, and
recovery as `telemetry: trace export recovered`. Give it a minute: traces batch
every 5 seconds and metrics export every 30, so checking immediately after
sending traffic tells you nothing. `docs/OBSERVABILITY.md` has the rest.

## Teardown

```sh
make clean      # kind delete cluster --name relay
```

Postgres uses an `emptyDir`, so all stored events go with the pod. That is
fine locally and is why `k8s/local/postgres.yaml` is not a production
database.

## When it does not work

**Pods stuck `Init:0/2`.** The `wait-for-db` container is waiting on Postgres,
which it does for up to 120 seconds. Normal on a cold cluster.

```sh
kubectl -n relay logs <pod> -c wait-for-db
kubectl -n relay rollout status deploy/postgres
```

**`make deploy` fails at the `ScalingActive` wait.** metrics-server is not
working, so the HPA has no CPU metric and cannot scale, not even up to
`minReplicas`.

```sh
kubectl -n kube-system get pods -l k8s-app=metrics-server
kubectl api-resources --api-group=metrics.k8s.io    # empty means the APIService is missing
```

**`hpa/relay` shows `<unknown>/70%`.** Same cause. Nothing else needs fixing.

**`ErrImagePull` or `ImagePullBackOff` on relay.** You skipped `make load`, or
rebuilt without reloading. Run `make build load` and restart the deployment.

**`net/http: TLS handshake timeout` while pulling.** Docker Desktop routing
through a stale proxy. Restart Docker Desktop and pull the image directly
(`docker pull postgres:16-alpine`) before re-running.

**`CreateContainerConfigError`.** A Secret or ConfigMap key the Deployment
asks for does not exist. `kubectl -n relay describe pod <pod>` names it.

**Port 8080 refuses connections.** Either the cluster was created without
`kind-config.yaml`, so the port mapping does not exist, or no relay pod is
Ready yet. `kubectl -n relay get pods` first, then
`docker port relay-control-plane`.
