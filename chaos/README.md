# Kubernetes chaos verification

A finite interpreter verification Job runs against a fresh, operator-managed
three-node Restate cluster. Chaos Mesh repeatedly injects faults for a fixed
window. After all faults are removed, the same Job must finish and verify its
independently calculated counters within a bounded completion period.

Temporary unavailability during chaos is allowed. This suite tests eventual
recovery and counter correctness, not an availability SLA.

## Run

Prerequisites: Node.js 22+, npm, Docker, kubectl, Helm, and kind. Give Docker at
least 12 GiB of memory. From the repository root:

```sh
npm install && npm run build
scripts/chaos-env.sh          # kind cluster with Chaos Mesh and the operator
SCENARIOS=pod-kill-one npm run chaos
kind delete cluster --name restate-chaos
```

The runner uses the current kubectl context; `chaos-env.sh` points it at the
kind cluster it created or reused. Any cluster with Chaos Mesh and the operator
installed works, but each scenario creates and deletes a RestateCluster named
after its own namespace, so only use a test cluster. Images must be pullable
from inside the cluster. An interrupted run leaves its namespace behind; remove
it with `kubectl delete restatecluster <namespace>`.

## Scenarios

| Name           | Fault                                  | Interval |
| -------------- | -------------------------------------- | -------- |
| `pod-kill-one` | Kill one randomly selected Restate pod | 60s      |

Victims are selected independently each time and may repeat; the saved
experiment records show the actual sequence. PVCs survive pod kills.

## Configuration

All inputs are environment variables; defaults live in `src/chaos/spec.ts`.

| Variable                     | Default                                           | Meaning                                                |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `SCENARIOS`                  | `all`                                             | Comma-separated names, or `all`, run sequentially      |
| `RESTATE_CONTAINER_IMAGE`    | `ghcr.io/restatedev/restate:main`                 | Candidate image                                        |
| `SERVICES_CONTAINER_IMAGE`   | `ghcr.io/restatedev/test-services-node:main`      | Interpreter services                                   |
| `DRIVER_IMAGE`               | `ghcr.io/restatedev/e2e-verification-runner:main` | Existing verification Job                              |
| `SEED`                       | Unique run ID                                     | Workload seed; Chaos Mesh victim selection is separate |
| `DRIVER_KEYS`                | `500`                                             | Interpreter keys                                       |
| `DRIVER_TESTS`               | `400000`                                          | Generated programs; must outlast the chaos window      |
| `DRIVER_MAX_PROGRAM_SIZE`    | `20`                                              | Maximum generated program size                         |
| `CHAOS_SECONDS`              | `300`                                             | Fixed chaos window                                     |
| `COMPLETION_TIMEOUT_SECONDS` | `900`                                             | Completion allowance after faults are removed          |
| `STARTUP_TIMEOUT_SECONDS`    | `300`                                             | Bound on each startup wait                             |
| `OUT`                        | `chaos/out/<run-id>`                              | Output directory                                       |

`chaos-env.sh` reads `KIND_CLUSTER`, `KIND_IMAGE`, `CHAOS_MESH_VERSION`, and
`OPERATOR_CHART_VERSION`. The driver's no-progress watchdog gets half the
completion allowance: long enough to tolerate a fault window, short enough to
dump invocation diagnostics when verification wedges.

For a quick local check, shrink the run: `CHAOS_SECONDS=130 DRIVER_TESTS=300000
COMPLETION_TIMEOUT_SECONDS=600` still yields two injections at a 60s interval.

## Results and debugging

A scenario passes when at least two experiments show injection evidence on
Restate pods, the Job was still running when faults were removed, all
experiments are gone afterwards, and the Job then succeeds within the
completion allowance. Anything else fails with a reason in `result.json` and a
nonzero exit. Finishing _submission_ during chaos is fine; the Job is only
rejected if it already succeeded before faults were removed.

Per scenario the output directory holds `result.json`, the rendered
`manifests/`, `chaos/` experiment records as last observed, `logs/` with one
file per pod incarnation and container for the workload, operator, and Chaos
Mesh namespaces, plus resource YAML, events, descriptions, and `restatectl
status` before and after.

## Add a scenario

Copy a Schedule in `scenarios/`, keep the name `experiment` and the `${NS}`
namespace, and scope every selector to Restate pods in that namespace; the unit
tests check this. Use `@every Ns` with `concurrencyPolicy: Forbid`, give
sustained faults a duration shorter than their interval, and leave at least
three scheduling opportunities in the window. Validate with `npm run test:chaos`,
then run the scenario against kind and read its experiment records.
