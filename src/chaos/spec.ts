// Copyright (c) 2026 - Restate Software, Inc., Restate GmbH
// This file is released under the MIT license.

// Configuration and acceptance rules, independent of Kubernetes I/O.
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const suite = resolve(__dirname, "../../chaos");

type Condition = { type: string; status: string };
type ContainerStatus = {
  name: string;
  restartCount: number;
  state: {
    running?: object;
    terminated?: { exitCode: number; finishedAt: string };
  };
};
export type Pod = {
  metadata: { name: string; uid: string; deletionTimestamp?: string };
  status?: {
    conditions?: Condition[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
};
export type Experiment = {
  kind: string;
  metadata: { name: string; uid: string };
  status?: {
    experiment?: {
      containerRecords?: {
        id: string;
        selectorKey: string;
        injectedCount?: number;
      }[];
    };
  };
};

export function settings(env = process.env) {
  const integer = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error(`${key} must be a positive integer`);
    return n;
  };
  const available = readdirSync(join(suite, "scenarios"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .sort();
  const selected = env.SCENARIOS ?? "all";
  const scenarios = selected === "all" ? available : selected.split(",");
  if (!scenarios.length || scenarios.some((s) => !available.includes(s)))
    throw new Error(`SCENARIOS must select from: ${available.join(", ")}`);
  const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  return {
    runId,
    seed: env.SEED ?? runId,
    out: resolve(env.OUT ?? join(suite, "out", runId)),
    scenarios,
    chaosSeconds: integer("CHAOS_SECONDS", 300),
    completionSeconds: integer("COMPLETION_TIMEOUT_SECONDS", 900),
    startupSeconds: integer("STARTUP_TIMEOUT_SECONDS", 300),
    keys: integer("DRIVER_KEYS", 500),
    tests: integer("DRIVER_TESTS", 400000),
    maxProgramSize: integer("DRIVER_MAX_PROGRAM_SIZE", 20),
    images: {
      RESTATE_CONTAINER_IMAGE:
        env.RESTATE_CONTAINER_IMAGE ?? "ghcr.io/restatedev/restate:main",
      SERVICES_CONTAINER_IMAGE:
        env.SERVICES_CONTAINER_IMAGE ??
        "ghcr.io/restatedev/test-services-node:main",
      DRIVER_IMAGE:
        env.DRIVER_IMAGE ?? "ghcr.io/restatedev/e2e-verification-runner:main",
    },
  };
}

// DRIVER_CONF is JSON-quoted, keeping arbitrary seeds a single YAML scalar.
export function render(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => {
    if (!(name in values))
      throw new Error(`Unknown manifest placeholder: ${name}`);
    return values[name];
  });
}

// Evidence that Chaos Mesh actually injected the fault into Restate pods of
// this scenario, rather than silently selecting nothing or failing to inject.
export function injected(experiment: Experiment, namespace: string) {
  const records = experiment.status?.experiment?.containerRecords ?? [];
  return (
    records.length > 0 &&
    records.every(
      (r) =>
        (r.injectedCount ?? 0) > 0 &&
        new RegExp(`^${namespace}/restate-[0-2]$`).test(r.id),
    )
  );
}

export function victims(experiment: Experiment) {
  return (experiment.status?.experiment?.containerRecords ?? [])
    .filter((r) => r.selectorKey === ".")
    .map((r) => r.id);
}

export function jobOutcome(job: {
  status?: { conditions?: Condition[]; succeeded?: number; failed?: number };
}) {
  const status = job.status;
  const has = (types: string[]) =>
    status?.conditions?.some(
      (c) => types.includes(c.type) && c.status === "True",
    );
  if (status?.failed || has(["Failed", "FailureTarget"])) return "FAIL";
  if (status?.succeeded || has(["Complete"])) return "PASS";
  return "RUNNING";
}
