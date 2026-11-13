CLUSTER := relay
IMAGE   := relay:latest
URL     := http://localhost:8080

.PHONY: cluster build load deploy up status logs smoke loadtest clean

cluster:
	kind create cluster --config kind-config.yaml

build:
	docker build -t $(IMAGE) app

load:
	kind load docker-image $(IMAGE) --name $(CLUSTER)

# k8s/local holds the stand-in Secret and Postgres. Production gets k8s/base only.
deploy:
	kubectl apply -f k8s/base/ -f k8s/local/
	kubectl -n kube-system rollout status deploy/metrics-server --timeout=180s
	kubectl -n relay rollout status deploy/postgres --timeout=180s
	kubectl -n relay rollout status deploy/relay --timeout=300s
	kubectl -n relay wait --for=condition=ScalingActive hpa/relay --timeout=180s

up: cluster build load deploy

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
