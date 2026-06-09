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
converging towards the expected counters. It fails fast (instead of letting the
CI job run until its timeout) and collects diagnostics in two cases: (1) the
total difference stops shrinking for a while (wedged), or (2) **paused**
interpreter invocations are detected — these never self-resolve, so the counters
can never converge. Each poll logs an invocation-status breakdown
(`running`/`suspended`/`backing-off`/`paused`/…) alongside the diff. The
diagnostics include:

- a status histogram of interpreter invocations, and the not-yet-completed
  invocations from the restate admin API (`sys_invocation`: status, what each is
  `suspended_waiting_for_*`, the caller chain, last failure),
- for each differing interpreter key, that object's current `state`, invocation
  history (`sys_invocation`, all statuses), `sys_journal`, and `sys_idempotency`
  mapping — so a lost (or extra) increment can be localized to a specific
  object/invocation/journal entry, and
- a goroutine dump of every SDK service container (via `SIGQUIT`, which is why
  `GOTRACEBACK=all` is set for those containers) plus a tail of every
  container's logs.

The journal/invocation history is only retained for already-completed
invocations if retention was enabled for the interpreter services (see
`INTERPRETER_JOURNAL_RETENTION` below).

Configure via environment variables:

- `STUCK_DETECTOR_TIMEOUT_SECONDS` — no-progress window before declaring the run
  stuck (default `2700`). Must be comfortably larger than one verification poll,
  which can take many minutes for large key spaces.
- `STUCK_DETECTOR_DUMP_GOROUTINES` — set to `false` to skip `SIGQUIT`ing the SDK
  containers (default `true`).
- `STUCK_DETECTOR_DISABLED` — set to any value to disable the watchdog entirely.
- `INTERPRETER_JOURNAL_RETENTION` — journal/idempotency retention applied to the
  interpreter services after registration, in the restate "friendly" duration
  format (default `3 hours`; set to `off` to leave service retention untouched).
  Retaining ~1M journals is storage-heavy, and the offending invocation may
  complete early in a run, so to reliably capture it the retention must span the
  whole run — tune this (and/or `tests` in the params file) for focused hunts.

## See [`run-verification.sh`](scripts/run-verification.sh)
