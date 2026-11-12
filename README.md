# Relay: inheriting a service

You have just joined the team. The engineer who owned `relay` has moved on and
left the notes in `docs/HANDOFF.md`. Product expects launch traffic to peak at
around 400 requests per second. The service is due to go to production on
Friday and you are now responsible for it.

## Your task

1. Get the service running locally on the kind cluster.
2. Make it ready for production.
3. Tell us what you did, what you left, and whether you would ship it on Friday.

"Ready for production" is deliberately not defined. Deciding what it means for
this service is part of the exercise.

You will not be able to fix everything, and we do not expect you to. We care
more about what you chose to do first, and why, than about how many things you
changed.

## What is in the repo

| Path | What it is |
|---|---|
| `app/` | The Node service and its Dockerfile |
| `k8s/` | Kubernetes manifests |
| `terraform/` | The AWS infrastructure production will be built from |
| `.github/workflows/` | The CI pipeline |
| `tools/load.js` | A load generator |
| `docs/HANDOFF.md` | Notes from the previous owner |

## Scope

- **Everything in the repo is yours to change**, including the application
  code, with one exception below.
- **Terraform is review-only.** It is part of what ships on Friday, so we want
  your assessment of it, but you do not need an AWS account and should not
  apply it. `terraform init -backend=false && terraform validate` is enough.
  Fix what you like in the code, and write up the rest.
- **`k8s/postgres.yaml` is out of scope.** It is a local stand-in for a managed
  database that another team owns.

## Getting started

You need Docker, [kind](https://kind.sigs.k8s.io/), kubectl and Node 22.
Terraform is optional.

```sh
make up          # create the cluster, build the image, load it, deploy
make status
make logs
make loadtest    # 150 req/s for 5 minutes against http://localhost:8080
make clean
```

`make up` will not give you a working service. Start there.

## What to send back

The repo with your changes as git commits, plus a `NOTES.md` at the root. The
first line of `NOTES.md` must be exactly one of `SHIP`, `SHIP WITH CONDITIONS`
or `DO NOT SHIP`. Somewhere in it, paste the final `total:` line from one load
test you ran, exactly as the tool printed it. Beyond that, cover:

1. **What you changed**, in the order you would defend it, with a line on why.
2. **What you found and deliberately left**, and why.
3. **Your call on Friday.** Ship, ship with conditions, or do not ship. What
   would you need from other teams first?
4. **Questions** you would have asked us if you could.

Keep `NOTES.md` to what a busy engineering lead would read. Evidence beats
assertion: if you say something breaks, say how you saw it break.

## Ground rules

- Use whatever tools you normally use, AI assistants included.
- There is a 30-minute follow-up call where we will ask you to explain your
  changes and change a requirement or two.
- If something in the brief is ambiguous, make a decision and write it down.
