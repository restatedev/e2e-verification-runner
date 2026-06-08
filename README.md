# Verification Runner

## Install and build

To get all the dependencies required to develop the node services:

```shell
$ npm install
```

To build:

```shell
$ npm run build
```

## Build and push the docker image:
A node services Docker image is used by the verification tests in Kubernetes.

```shell
$ docker build --platform linux/arm64,linux/amd64 -t ghcr.io/restatedev/e2e-verification-runner --push .
```

## Lint and format

Linting is run together with `gradle check`, you can format using:

```shell
$ npm run format
```

## Running the services

### As a webapp

```shell
SERVICES=InterpreterDriver node dist/app.js
```

## As a standalone job

```shell
SERVICES=InterpreterDriverJob node dist/app.js
```

## Stuck-run detector

During the verification phase the driver watches whether the state keeps
converging towards the expected counters. If the total difference stops
shrinking for a while (the run is wedged, e.g. an invocation got stuck), the
driver collects diagnostics and fails fast instead of letting the CI job run
until its timeout. The diagnostics include:

- the not-yet-completed invocations from the restate admin API
  (`sys_invocation`: status, what each is `suspended_waiting_for_*`, the caller
  chain, last failure), and
- a goroutine dump of every SDK service container (via `SIGQUIT`, which is why
  `GOTRACEBACK=all` is set for those containers) plus a tail of every
  container's logs.

Configure via environment variables:

- `STUCK_DETECTOR_TIMEOUT_SECONDS` — no-progress window before declaring the run
  stuck (default `1800`). Must be comfortably larger than one verification poll,
  which can take many minutes for large key spaces.
- `STUCK_DETECTOR_DUMP_GOROUTINES` — set to `false` to skip `SIGQUIT`ing the SDK
  containers (default `true`).
- `STUCK_DETECTOR_DISABLED` — set to any value to disable the watchdog entirely.

## See [`run-verification.sh`](scripts/run-verification.sh)
