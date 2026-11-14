CLUSTER := relay
IMAGE   := relay:latest
URL     := http://localhost:8080

.PHONY: cluster build load preload deploy up status logs smoke loadtest clean

cluster:
	kind create cluster --config kind-config.yaml

build:
	docker build -t $(IMAGE) app

load:
	kind load docker-image $(IMAGE) --name $(CLUSTER)

# The nodes can pull these themselves, but a kind node's pull is the slowest
# and least debuggable part of a cold start: when one stalls, the only symptom
# is a pod sitting in ContainerCreating, and loading the image afterwards does
# not help until the pod is recreated. Pulling on the host instead shows
# progress and is cached across clusters. Already-present images are not
# re-pulled.
UPSTREAM := postgres:16-alpine \
            otel/opentelemetry-collector-contrib:0.160.0 \
            registry.k8s.io/metrics-server/metrics-server:v0.7.2

preload:
	@for img in $(UPSTREAM); do \
	  docker image inspect $$img >/dev/null 2>&1 || docker pull $$img; \
	  kind load docker-image $$img --name $(CLUSTER); \
	done

# k8s/local holds the stand-in Secret, Postgres, collector and metrics-server.
# Production gets k8s/base only.
#
# kubectl applies -f sources in the order given. The namespace comes first
# because everything in k8s/local lives in it, then local, then base, so
# metrics-server and Postgres are already running when the relay Deployment
# and its HPA appear. Otherwise relay is created at one replica and waits for
# the HPA to come alive, and its wait-for-db container retries until Postgres
# is reachable.
deploy:
	kubectl apply -f k8s/base/00-namespace.yaml -f k8s/local/ -f k8s/base/
	kubectl -n kube-system rollout status deploy/metrics-server --timeout=180s
	kubectl -n relay rollout status deploy/postgres --timeout=300s
	kubectl -n relay rollout status deploy/relay --timeout=300s
	kubectl -n relay wait --for=condition=ScalingActive hpa/relay --timeout=180s
	sh tools/wait-scaled.sh

up: cluster build load preload deploy

status:
	kubectl -n relay get deploy,pods,svc,hpa,pdb -o wide

logs:
	kubectl -n relay logs -l app=relay --tail=100 --prefix

smoke:
	sh tools/smoke.sh $(URL)

# make loadtest RPS=150 DURATION=300
RPS      ?= 150
DURATION ?= 300
loadtest:
	node tools/load.js --url $(URL) --rps $(RPS) --duration $(DURATION)

clean:
	kind delete cluster --name $(CLUSTER)
