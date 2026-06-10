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

## Downloading run logs

Each verification workflow uploads a `logs/` build artifact
(`verification-<sdk>-log`) containing the driver's own output
(`verification.log`) and one file per container under `containers/` (restate
nodes + SDK services). Container output is streamed straight to those files
instead of being multiplexed into the driver's stdout, so the inline GitHub log
stays small/scrollable and the full per-container logs (including the Go
goroutine dump on a stuck run) live in the artifact. Prefer downloading the
artifact over the GitHub "Download log archive" button — the run-log archive is
a large, non-resumable stream that often fails mid-download, whereas the artifact
is compressed and fetched robustly:

```shell
gh run download <run-id> -R restatedev/e2e-verification-runner -n verification-go-log
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
  history (`sys_invocation`, all statuses), and `sys_journal` — so a lost (or
  extra) increment can be localized to a specific object/invocation/journal
  entry, and
- on Go runs (when `STUCK_DETECTOR_DUMP_GOROUTINES=true`), a `SIGQUIT` to each
  SDK service container so it emits a goroutine dump (`GOTRACEBACK=all` is set
  for those containers). The dump and all container output are captured in the
  per-container log files (see "Downloading run logs"), not tailed inline.

The journal/invocation history is only retained for already-completed
invocations if retention was enabled for the interpreter services (see
`INTERPRETER_JOURNAL_RETENTION` below).

Configure via environment variables:

- `STUCK_DETECTOR_TIMEOUT_SECONDS` — no-progress window before declaring the run
  stuck (default `2700`). Must be comfortably larger than one verification poll,
  which can take many minutes for large key spaces.
- `STUCK_DETECTOR_DUMP_GOROUTINES` — set to `true` to `SIGQUIT` the SDK service
  containers for a goroutine dump (default off). Only meaningful for Go services,
  so the Go verification workflow sets it; other SDKs leave it off.
- `STUCK_DETECTOR_DISABLED` — set to any value to disable the watchdog entirely.
- `INTERPRETER_JOURNAL_RETENTION` — journal/idempotency retention applied to the
  interpreter services after registration, in the restate "friendly" duration
  format (default `3 hours`; set to `off` to leave service retention untouched).
  Retaining ~1M journals is storage-heavy, and the offending invocation may
  complete early in a run, so to reliably capture it the retention must span the
  whole run — tune this (and/or `tests` in the params file) for focused hunts.

## See [`run-verification.sh`](scripts/run-verification.sh)
