#!/bin/sh
# The Deployment has no replicas field, so it is created at 1 and the HPA
# climbs to minReplicas. rollout status is satisfied at 1/1, which is not
# enough to test anything about behaviour across pods.
set -e

NS="${1:-relay}"
min=$(kubectl -n "$NS" get hpa relay -o jsonpath='{.spec.minReplicas}')
: "${min:?could not read minReplicas from hpa/relay}"

i=0
while [ "$i" -lt 60 ]; do
  ready=$(kubectl -n "$NS" get deploy relay -o jsonpath='{.status.readyReplicas}')
  ready=${ready:-0}
  if [ "$ready" -ge "$min" ]; then
    echo "relay: $ready ready replicas (minReplicas $min)"
    exit 0
  fi
  i=$((i + 1))
  sleep 3
done

echo "relay reached only $ready ready replicas, expected at least $min"
kubectl -n "$NS" get deploy,hpa,pods -l app=relay
exit 1
