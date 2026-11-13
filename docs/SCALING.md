# Scaling

## Who owns the replica count

The HPA does. `k8s/base/deployment.yaml` has no `replicas` field.

A Deployment under an HPA should not declare `replicas`. If it does, every
`kubectl apply` writes that number back, so a deploy during busy traffic scales
the service down to the manifest's value and the HPA has to climb back up.
`minReplicas: 3` in `k8s/base/hpa.yaml` is the floor instead.

The CPU request is what makes the HPA's target mean anything. `averageUtilization: 70`
is 70% of `requests.cpu`, which is `250m`, so a pod is considered saturated at
175m and the HPA adds capacity from there.

## metrics-server is a hard requirement

Without it the HPA cannot scale **at all**, including up to `minReplicas`. This
is worth stating because it is the opposite of what you might assume. Tested on
this cluster by scaling to one replica with no metrics-server installed:

```
relay   1/1   1   1

Conditions:
  AbleToScale    True    SucceededGetScale
  ScalingActive  False   FailedGetResourceMetric   unable to get metrics for resource cpu
```

It stayed at one pod. The HPA reports `AbleToScale: True` the whole time, so the
only honest signal is `ScalingActive`.

So on a cluster with no metrics-server, a Deployment with no `replicas` field is
created at the Kubernetes default of **1** and stays there. That is a
single-pod production, and the PodDisruptionBudget's `minAvailable: 2` then
blocks every voluntary eviction, so node drains and cluster upgrades hang.

Two things guard against that:

- `make deploy` waits on the metrics-server rollout and then on
  `hpa/relay` reaching `ScalingActive`.
- `.github/workflows/deploy.yml` does the same after `rollout status`, so a
  production cluster without metrics-server fails the deploy rather than
  quietly running one pod.

EKS does not install metrics-server. Nothing in `terraform/` installs it
either, so somebody has to, and it belongs to whoever owns the cluster rather
than to this repo.

`k8s/local/metrics-server.yaml` is the upstream v0.7.2 manifest with
`--kubelet-insecure-tls` added, because kind's kubelets serve self-signed
certificates. That flag turns off verification of the kubelet's certificate and
is the reason the file is local-only. A real cluster installs metrics-server
without it.

## What the numbers mean

| Setting | Value | Why |
|---|---|---|
| `requests.cpu` | `250m` | The HPA target is a percentage of this. Also what the scheduler packs against. |
| `minReplicas` | `3` | Survives one pod failing and one node draining at the same time. |
| `maxReplicas` | `10` | `PG_POOL_MAX` is 8, so 10 pods is 80 connections against a hard cap of 100, leaving the superuser reserve and the migration connection. |
| `averageUtilization` | `70` | Leaves headroom for the scale-up to complete before pods saturate. |
| PDB `minAvailable` | `2` | A drain cannot take the service below two pods. |

The connection budget is what sets `maxReplicas`, not the other way round. If
the data team ever raises `max_connections`, raise `maxReplicas` and
`PG_POOL_MAX` together, and keep their product under the cap.

## Not verified

The HPA has never been observed scaling on real load, because the sandbox here
would not let metrics-server install on the local cluster. CI exercises the
path on a fresh kind cluster, which proves metrics-server comes up and the HPA
reaches `ScalingActive` with no `replicas` field present. What is untested is
behaviour under sustained CPU pressure: whether `70` is the right target and
whether the default scale-down stabilisation of 5 minutes is too twitchy for
this traffic shape. Both want a load test against a cluster with real metrics.
