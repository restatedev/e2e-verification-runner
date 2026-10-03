// Copyright (c) 2026 - Restate Software, Inc., Restate GmbH
// This file is released under the MIT license.

// Runs one Chaos Mesh scenario per selected name against a fresh,
// operator-managed RestateCluster in the current kubeconfig context. The
// cluster must already have Chaos Mesh and the Restate operator installed;
// scripts/chaos-env.sh does that for a disposable kind cluster.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Experiment,
  Pod,
  injected,
  jobOutcome,
  render,
  settings,
  suite,
  victims,
} from "./spec";

type Result = {
  scenario: string;
  namespace: string;
  verdict: "PASS" | "FAIL";
  phase: string;
  reasons: string[];
  startedAt: string;
  chaosStartedAt?: string;
  chaosEndedAt?: string;
  finishedAt?: string;
  injections: { experiment: string; victims: string[] }[];
};

const now = () => new Date().toISOString();
const DRIVER_STARTED = /Send \d+ programs/;

export async function main(config = settings()) {
  const { execa } = await import("execa");
  // Argument-safe commands without a shell; stdout is returned, stderr shown.
  const $ =
    (timeout = 30_000) =>
    (strings: TemplateStringsArray, ...args: (string | string[])[]) =>
      execa({
        timeout,
        killDescendants: true,
        maxBuffer: 32 * 1024 * 1024,
        stripFinalNewline: false,
        stderr: "inherit",
      })(strings, ...args).then((output) => output.stdout);
  const json = async (output: Promise<string>) => JSON.parse(await output);
  await mkdir(config.out, { recursive: true });
  await writeFile(
    join(config.out, "run.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  const results: Result[] = [];

  for (const scenario of config.scenarios) {
    const namespace = `chaos-${config.runId}-${scenario}`;
    const dir = join(config.out, scenario);
    for (const sub of ["logs", "chaos", "manifests"])
      await mkdir(join(dir, sub), { recursive: true });
    const k = ["kubectl", "-n", namespace, "--request-timeout=20s"];
    const save = async (name: string, data: unknown) => {
      const value = await data;
      const path = join(dir, name);
      await writeFile(
        path,
        typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2) + "\n",
      );
      return path;
    };
    // Diagnostics must never hide the result they are meant to explain.
    const snapshot = (name: string, output: Promise<string>) =>
      save(name, output).catch((error) =>
        console.error(`[${scenario}] ${name}: ${String(error)}`),
      );
    const result: Result = {
      scenario,
      namespace,
      verdict: "FAIL",
      phase: "setup",
      reasons: [],
      startedAt: now(),
      injections: [],
    };
    results.push(result);
    const values = {
      NS: namespace,
      ...config.images,
      JOB_DEADLINE_SECONDS: String(
        config.startupSeconds + config.chaosSeconds + config.completionSeconds,
      ),
      // Faults are short relative to this window, so the driver's stuck
      // detector can still collect invocation-level diagnostics on a wedge.
      STUCK_DETECTOR_SECONDS: String(Math.ceil(config.completionSeconds / 2)),
      DRIVER_CONF: JSON.stringify(
        JSON.stringify({
          seed: config.seed,
          keys: config.keys,
          tests: config.tests,
          maxProgramSize: config.maxProgramSize,
          bootstrap: false,
          ingress: "http://restate:8080",
          register: {
            adminUrl: "http://restate:9070",
            deployments: ["http://test-services:9080"],
          },
        }),
      ),
    };
    const apply = async (file: string) => {
      const text = render(await readFile(join(suite, file), "utf8"), values);
      await $()`kubectl apply -f ${await save(`manifests/${basename(file)}`, text)}`;
    };

    // Killed pods take their logs with them, so every container incarnation
    // (pod UID plus restart count) is followed into its own file. Polling only
    // discovers new incarnations; `logs --follow` starts at the beginning of the
    // container log, so lines written before discovery are still captured.
    const streaming = new AbortController();
    const streams = new Map<string, Promise<unknown>>();
    let pods: Pod[] = [];
    const capture = async (ns: string) => {
      const seen: Pod[] = (
        await json($()`kubectl -n ${ns} --request-timeout=20s get pods -o json`)
      ).items;
      if (ns === namespace) pods = seen;
      for (const pod of seen)
        for (const container of [
          ...(pod.status?.initContainerStatuses ?? []),
          ...(pod.status?.containerStatuses ?? []),
        ]) {
          const key = `${pod.metadata.uid}/${container.name}/${container.restartCount}`;
          if (
            streams.has(key) ||
            !(container.state.running || container.state.terminated)
          )
            continue;
          const file = {
            file: join(
              dir,
              "logs",
              `${ns}-${pod.metadata.name}-${pod.metadata.uid.slice(0, 8)}-${container.name}-${container.restartCount}.log`,
            ),
            append: true,
          };
          streams.set(
            key,
            execa({
              cancelSignal: streaming.signal,
              reject: false,
              buffer: false,
              stdout: file,
              stderr: file,
            })`kubectl -n ${ns} logs ${pod.metadata.name} -c ${container.name} --follow --timestamps`.then(
              (output) => {
                // A broken connection is retried on the next capture. The retry
                // replays the container log, so this rare case repeats lines.
                if (output.failed && !streaming.signal.aborted)
                  streams.delete(key);
              },
            ),
          );
        }
    };
    const captureAll = () =>
      Promise.all(
        [namespace, "restate-operator", "chaos-mesh"].map((ns) =>
          capture(ns).catch((error) =>
            console.error(`[${scenario}] logs ${ns}: ${String(error)}`),
          ),
        ),
      );
    const poll = async (
      label: string,
      seconds: number,
      predicate: () => Promise<boolean>,
    ) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        await captureAll();
        if (await predicate()) return;
        await sleep(2000);
      }
      throw new Error(`Timed out: ${label}`);
    };
    const job = async () =>
      jobOutcome(await json($()`${k} get job chaos-driver -o json`));

    const experiments = new Map<string, Experiment>();
    const remember = async () => {
      const list = await json(
        $()`${k} get podchaos,networkchaos -l managed-by=experiment -o json`,
      );
      for (const experiment of list.items as Experiment[]) {
        experiments.set(experiment.metadata.uid, experiment);
        await save(`chaos/${experiment.metadata.name}.json`, experiment);
      }
    };
    let chaosStopped = true;
    const stopChaos = async () => {
      if (chaosStopped) return;
      await remember().catch(() => undefined);
      // The Chaos Mesh webhook rejects the garbage collector, so children are
      // deleted explicitly below; deleting them is what heals sustained faults.
      await $(
        60_000,
      )`${k} delete schedule experiment --ignore-not-found --cascade=background --wait=true --timeout=60s`;
      await remember().catch(() => undefined);
      await $(
        130_000,
      )`${k} delete podchaos,networkchaos -l managed-by=experiment --ignore-not-found --wait=true --timeout=120s`;
      if (
        (
          await json(
            $()`${k} get podchaos,networkchaos -l managed-by=experiment -o json`,
          )
        ).items.length
      )
        throw new Error("Chaos experiments remain after deletion");
      chaosStopped = true;
    };

    try {
      console.log(`[${scenario}] Deploying ${namespace}`);
      await apply("manifests/restate-cluster.yaml");
      await poll(
        "three Ready Restate pods",
        config.startupSeconds,
        async () => {
          const restate = pods.filter((p) =>
            /^restate-[0-2]$/.test(p.metadata.name),
          );
          return (
            restate.length === 3 &&
            restate.every(
              (p) =>
                !p.metadata.deletionTimestamp &&
                p.status?.conditions?.some(
                  (c) => c.type === "Ready" && c.status === "True",
                ),
            )
          );
        },
      );
      await snapshot(
        "status-before.txt",
        $()`${k} exec restate-0 -- restatectl status`,
      );
      await apply("manifests/test-services.yaml");
      await $(
        config.startupSeconds * 1000,
      )`${k} rollout status deployment/test-services --timeout=${String(config.startupSeconds)}s`;
      await apply("manifests/driver.yaml");
      result.phase = "starting workload";
      await poll("first submitted batch", config.startupSeconds, async () => {
        if ((await job()) !== "RUNNING")
          throw new Error(
            "Verification Job ended before chaos started; check its logs or increase DRIVER_TESTS",
          );
        // Only ask for logs once the driver container exists, to keep
        // "waiting to start" noise out of the run output.
        const started = pods.some(
          (p) =>
            p.metadata.name.startsWith("chaos-driver-") &&
            p.status?.containerStatuses?.some(
              (c) => c.state.running || c.state.terminated,
            ),
        );
        return (
          started &&
          DRIVER_STARTED.test(
            await $()`${k} logs job/chaos-driver --tail=20`.catch(() => ""),
          )
        );
      });

      result.phase = "chaos";
      result.chaosStartedAt = now();
      chaosStopped = false;
      await apply(`scenarios/${scenario}.yaml`);
      console.log(`[${scenario}] Chaos for ${config.chaosSeconds}s`);
      const until = Date.now() + config.chaosSeconds * 1000;
      while (Date.now() < until) {
        await captureAll();
        await remember();
        const state = await job();
        if (state === "FAIL")
          throw new Error("Verification Job failed during chaos");
        if (state === "PASS")
          throw new Error(
            "Workload completed during chaos; increase DRIVER_TESTS",
          );
        await sleep(Math.min(2000, Math.max(0, until - Date.now())));
      }

      result.phase = "removing chaos";
      result.chaosEndedAt = now();
      await stopChaos();
      result.injections = [...experiments.values()]
        .filter((e) => injected(e, namespace))
        .map((e) => ({ experiment: e.metadata.name, victims: victims(e) }));
      if (result.injections.length < 2)
        throw new Error(
          `Only ${result.injections.length} verified injections; need at least two`,
        );
      // A Job finishing between the last poll and fault removal was not tested.
      const drivers: Pod[] = (
        await json($()`${k} get pods -l app=chaos-driver -o json`)
      ).items;
      if (
        drivers.some((p) =>
          p.status?.containerStatuses?.some(
            (c) =>
              c.state.terminated?.exitCode === 0 &&
              Date.parse(c.state.terminated.finishedAt) <=
                Date.parse(result.chaosEndedAt!),
          ),
        )
      )
        throw new Error(
          "Workload completed during chaos; increase DRIVER_TESTS",
        );

      result.phase = "completion";
      console.log(
        `[${scenario}] Chaos stopped; waiting up to ${config.completionSeconds}s for verification`,
      );
      await poll(
        "verification Job completion",
        config.completionSeconds,
        async () => {
          const state = await job();
          if (state === "FAIL") throw new Error("Verification Job failed");
          return state === "PASS";
        },
      );
      result.verdict = "PASS";
    } catch (error) {
      result.reasons.push(String(error));
    } finally {
      try {
        await stopChaos();
      } catch (error) {
        result.verdict = "FAIL";
        result.reasons.push(`Fault cleanup failed: ${String(error)}`);
      }
      await captureAll();
      await Promise.all([
        snapshot(
          "resources.yaml",
          $()`${k} get pods,services,deployments,statefulsets,jobs,pvc,networkpolicies -o yaml`,
        ),
        snapshot("events.yaml", $()`${k} get events -o yaml`),
        snapshot("describe.txt", $()`${k} describe pods,jobs,pvc`),
        snapshot(
          "restate-cluster.yaml",
          $()`kubectl get restatecluster ${namespace} -o yaml`,
        ),
        snapshot(
          "status-after.txt",
          $()`${k} exec restate-0 -- restatectl status`,
        ),
      ]);
      streaming.abort();
      await Promise.all(streams.values());
      try {
        await $(
          65_000,
        )`kubectl delete restatecluster ${namespace} --ignore-not-found --wait=true --timeout=60s`;
        // PVC and pod finalizers routinely need more than a minute here.
        await $(
          185_000,
        )`kubectl wait --for=delete namespace/${namespace} --timeout=180s`;
      } catch (error) {
        result.verdict = "FAIL";
        result.reasons.push(`Cluster cleanup failed: ${String(error)}`);
      }
      result.finishedAt = now();
      await save("result.json", result);
      console.log(
        `[${scenario}] ${result.verdict}${result.reasons.length ? `: ${result.reasons.join("; ")}` : ""}`,
      );
    }
  }
  console.log(`Artifacts: ${config.out}`);
  if (results.some((r) => r.verdict !== "PASS")) process.exitCode = 1;
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
