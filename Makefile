CLUSTER := relay
IMAGE   := relay:latest
URL     := http://localhost:8080

.PHONY: cluster build load deploy up status logs loadtest clean

cluster:
	kind create cluster --config kind-config.yaml

build:
	docker build -t $(IMAGE) app

load:
	kind load docker-image $(IMAGE) --name $(CLUSTER)

deploy:
	kubectl apply -f k8s/

up: cluster build load deploy

status:
	kubectl -n relay get deploy,pods,svc,hpa -o wide

logs:
	kubectl -n relay logs -l app=relay --tail=100 --prefix

# make loadtest RPS=150 DURATION=300
RPS      ?= 150
DURATION ?= 300
loadtest:
	node tools/load.js --url $(URL) --rps $(RPS) --duration $(DURATION)

clean:
	kind delete cluster --name $(CLUSTER)
