// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import { Program, CommandType } from "./commands";
import { Random } from "./random";
import { Cluster, createCluster } from "./infra";
import { CLUSTER } from "./dist_spec";
import { ProgramGenerator } from "./test_generator";

import { batch, retry, sleep } from "./utils";
import {
  getCounts,
  getInvocationStatusCounts,
  sendInterpreter,
} from "./raw_client";
import { collectDiagnostics, DifferingKey } from "./diagnostics";

// A paused invocation never self-resolves (it waits for a manual resume), so
// even one means the verifier will hang forever. Require it to persist for a
// couple of polls before failing, to avoid acting on a transient read.
const PAUSED_CONFIRM_POLLS = 2;

function computeDifferingKeys(
  expected: number[][],
  counters: number[][],
): DifferingKey[] {
  const out: DifferingKey[] = [];
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < expected[i].length; j++) {
      if (expected[i][j] !== counters[i][j]) {
        out.push({
          layer: i,
          key: j,
          expected: expected[i][j],
          actual: counters[i][j],
        });
      }
    }
  }
  return out;
}

// Cap how many differing keys we introspect in diagnostics, to bound output if
// a large number of keys diverge.
const MAX_DIFFERING_KEYS_TO_DUMP = 50;

// Retention applied to the interpreter services so that completed invocations'
// journals and idempotency mappings survive long enough for the stuck detector
// to dump them. Uses the restate "friendly" duration format, e.g. "3 hours".
// Set to "off" (or empty) to leave the services' retention untouched.
//
// NOTE: the offending invocation may complete early in a run (during the send
// phase), potentially long before detection, so fully capturing its journal
// needs retention spanning the whole run. Retaining ~1M journals is
// storage-heavy; tune this (and/or `tests` in the params file) for focused hunts.
const INTERPRETER_JOURNAL_RETENTION =
  process.env.INTERPRETER_JOURNAL_RETENTION ?? "3 hours";

const MAX_LAYERS = 3;

// Watchdog: if the verification phase makes no progress (the total difference
// does not shrink) for this many seconds, we assume the run is wedged, dump
// diagnostics, and fail fast instead of waiting for the CI job timeout.
const STALL_TIMEOUT_SECONDS = parseInt(
  process.env.STUCK_DETECTOR_TIMEOUT_SECONDS ?? "1800",
  10,
);
const STALL_DETECTOR_DISABLED = !!process.env.STUCK_DETECTOR_DISABLED;
// SIGQUIT the SDK service containers to capture goroutine dumps. Only useful
// for Go services (and it crashes the process), so it's opt-in: runs that use
// Go test services set STUCK_DETECTOR_DUMP_GOROUTINES=true. Off by default.
const STALL_DUMP_GOROUTINES =
  process.env.STUCK_DETECTOR_DUMP_GOROUTINES === "true";
// Capture each runtime node's /restate-data dir on a wedged run. Off by default
// (the dirs can be large and it gracefully stops the nodes); enable in CI
// workflows that want the on-disk RocksDB/metadata state for post-mortem.
const STALL_DUMP_DATA_DIRS = process.env.STUCK_DETECTOR_DUMP_DATA === "true";

export interface TestConfigurationDeployments {
  adminUrl: string;
  deployments: string[];
}

export type TestConfigurationRollingUpgrade = Record<
  string,
  "forward" | "backward" | "random"
>;

export interface TestConfiguration {
  readonly ingress: string;
  readonly seed: string;
  readonly keys: number;
  readonly tests: number;
  readonly maxProgramSize: number;
  readonly register?: TestConfigurationDeployments; // auto register the following endpoints
  readonly bootstrap?: boolean;
  readonly crashInterval?: number;
  readonly crashHard?: boolean;
  // specify the rolling upgrade strategy for the containers listed in the following config.
  // For any containers in this list, the test will attempt to upgrade the container
  // to the next image in the list.
  // <!> note: for any container that is specified in this list, it's corresponding env
  ///    definition must contain a list of ordered images.
  //     see: ContainerSpec.images in infra.ts
  readonly rollingUpgrade?: TestConfigurationRollingUpgrade;
}

export enum TestStatus {
  NOT_STARTED = "NOT_STARTED",
  RUNNING = "RUNNING",
  VALIDATING = "VALIDATING",
  FINISHED = "FINISHED",
  FAILED = "FAILED",
}

class StateTracker {
  private states: number[][] = [];

  constructor(
    private readonly numLayers: number,
    private readonly numInterpreters: number,
  ) {
    for (let i = 0; i < numLayers; i++) {
      const layerState = [];
      for (let j = 0; j < this.numInterpreters; j++) {
        layerState.push(0);
      }
      this.states.push(layerState);
    }
  }

  update(layer: number, id: number, program: Program) {
    if (layer >= this.numLayers) {
      throw new Error(`InterpreterDriver bug.`);
    }
    for (const command of program.commands) {
      switch (command.kind) {
        case CommandType.INCREMENT_STATE_COUNTER:
        case CommandType.INCREMENT_STATE_COUNTER_INDIRECTLY:
        case CommandType.INCREMENT_VIA_DELAYED_CALL:
        case CommandType.INCREMENT_STATE_COUNTER_VIA_AWAKEABLE: {
          this.states[layer][id] += 1;
          break;
        }
        case CommandType.CALL_NEXT_LAYER_OBJECT: {
          this.update(layer + 1, command.key, command.program);
          break;
        }
      }
    }
  }

  getLayer(layer: number): number[] {
    return this.states[layer];
  }

  getStates(): number[][] {
    return this.states;
  }
}

export class Test {
  readonly random: Random;
  readonly stateTracker: StateTracker;

  status: TestStatus = TestStatus.NOT_STARTED;
  containers: Cluster | undefined = undefined;

  constructor(readonly conf: TestConfiguration) {
    this.random = new Random(conf.seed);
    this.stateTracker = new StateTracker(MAX_LAYERS, conf.keys);
  }

  testStatus(): TestStatus {
    return this.status;
  }

  *generate() {
    const testCaseCount = this.conf.tests;
    const gen = new ProgramGenerator(
      this.random,
      this.conf.keys,
      this.conf.maxProgramSize,
    );

    const keys = this.conf.keys;
    const rnd = this.random;
    for (let i = 0; i < testCaseCount; i++) {
      const program = gen.generateProgram(0);
      const id = Math.floor(rnd.random() * keys);
      yield { id, program };
    }
  }

  async ingressReady(ingressUrl: string) {
    for (;;) {
      try {
        const rc = await fetch(`${ingressUrl}/restate/health`);
        if (rc.ok) {
          break;
        }
      } catch (e) {
        // suppress
      }
      console.log(`Waiting for ${ingressUrl} to be healthy...`);
      await sleep(2000);
    }
    console.log(`Ingress is ready. ${ingressUrl}`);
  }

  async registerEndpoints(adminUrl?: string, deployments?: string[]) {
    if (!adminUrl) {
      throw new Error("Missing adminUrl");
    }
    if (!deployments) {
      throw new Error("Missing register.deployments (array of uri string)");
    }
    for (;;) {
      try {
        const rc = await fetch(`${adminUrl}/health`);
        if (rc.ok) {
          break;
        }
      } catch (e) {
        // suppress
      }
      console.log(`Waiting for ${adminUrl} to be healthy...`);
      await sleep(2000);
    }
    console.log(`Admin is ready. ${adminUrl}`);
    console.log(
      `🌍 RESTATE_ADMIN_URL=${adminUrl} ./target/debug/restate inv ls`,
    );
    for (const uri of deployments) {
      for (;;) {
        try {
          const res = await fetch(`${adminUrl}/deployments`, {
            method: "POST",
            body: JSON.stringify({
              uri,
            }),
            headers: {
              "Content-Type": "application/json",
            },
          });
          if (!res.ok) {
            throw new Error(
              `unable to register ${uri} because: ${await res.text()}`,
            );
          }
          break;
        } catch (e) {
          console.error(e);
          console.log(`Trying again...`);
          await sleep(2000);
        }
      }
    }
    console.log("Registered deployments");
  }

  // Enables journal + idempotency retention on the interpreter services so that,
  // when the stuck detector fires tens of minutes into a run, the offending
  // object's journal and invocation history are still queryable. Best-effort:
  // a failure here only degrades diagnostics, so it must not fail the run.
  //
  // idempotency_retention caps journal_retention for invocations carrying an
  // idempotency key (the top-level interpreter sends do), so we set both.
  async configureInterpreterRetention(adminUrl?: string) {
    const retention = INTERPRETER_JOURNAL_RETENTION.trim();
    if (!adminUrl || retention === "" || retention.toLowerCase() === "off") {
      return;
    }
    const services = [
      ...Array.from({ length: MAX_LAYERS }, (_, l) => `ObjectInterpreterL${l}`),
      "ServiceInterpreterHelper",
    ];
    for (const name of services) {
      try {
        const res = await fetch(`${adminUrl}/services/${name}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            journal_retention: retention,
            idempotency_retention: retention,
          }),
        });
        if (!res.ok) {
          console.warn(
            `Could not set retention on ${name}: ${res.status} ${await res.text()}`,
          );
        } else {
          console.log(
            `Set journal/idempotency retention=${retention} on ${name}`,
          );
        }
      } catch (e) {
        console.warn(`Could not set retention on ${name}:`, e);
      }
    }
  }

  async go(): Promise<TestStatus> {
    try {
      return await this.startTesting();
    } catch (e) {
      console.error(e);
      this.status = TestStatus.FAILED;
      throw e;
    } finally {
      await this.cleanup();
    }
  }

  async startTesting(): Promise<TestStatus> {
    console.log(this.conf);
    this.status = TestStatus.RUNNING;

    if (this.conf.bootstrap) {
      this.containers = createCluster(CLUSTER);
      await this.containers.start(this.conf.rollingUpgrade ?? {});
      console.log(this.containers);

      console.log("Mapped ports of the restate leader");
      console.log(this.containers.container("n1").ports());

      console.log(
        `🌍 RESTATE_CLUSTER_CONTROLLER_ADDRESS=http://localhost:${this.containers.container("n1").port(5122)} ./target/debug/restatectl status`,
      );

      await sleep(10 * 1000);
    }
    let ingressUrls;
    if (this.containers) {
      ingressUrls = [
        new URL(this.containers.hostContainerUrl("n1", 8080)),
        new URL(this.containers.hostContainerUrl("n2", 8080)),
        new URL(this.containers.hostContainerUrl("n3", 8080)),
      ];
    } else {
      ingressUrls = [new URL(this.conf.ingress)];
    }
    const adminUrl = () => {
      return (
        this.containers?.hostContainerUrl("n1", 9070) ??
        this.conf.register?.adminUrl
      );
    };
    let deployments: string[] | undefined = undefined;
    if (this.conf.register) {
      deployments = this.conf.register.deployments;
    } else if (this.containers) {
      deployments = [
        `http://interpreter_zero:9000`,
        `http://interpreter_one:9001`,
        `http://interpreter_two:9002`,
        `http://services:9003`,
      ];
    }
    if (deployments) {
      await this.registerEndpoints(adminUrl(), deployments);
    }
    // Enable retention so diagnostics can inspect completed invocations later.
    await this.configureInterpreterRetention(adminUrl());
    for (const url of ingressUrls) {
      await this.ingressReady(url.toString());
    }

    console.log("Generating ...");

    const killRestate = async () => {
      if (!this.containers) {
        return;
      }
      const interval = this.conf.crashInterval;
      if (!interval) {
        return;
      }

      const crashHard = this.conf.crashHard ?? false;

      for (;;) {
        await sleep(interval);
        if (
          this.status == TestStatus.FAILED ||
          this.status == TestStatus.FINISHED
        ) {
          break;
        }
        let container;
        const victim = Math.floor(Math.random() * 3) % 3;
        const victimName = `n${victim + 1}`; // servers are named n1, n2, n3...
        container = this.containers.container(victimName);
        console.log("Killing restate: " + victimName);
        if (crashHard) {
          await container.restartAndWipeData();
        } else if (
          this.conf.rollingUpgrade &&
          victimName in this.conf.rollingUpgrade
        ) {
          await container.rollImage();
        } else {
          await container.restart();
        }
        console.log(`Restate is back: ${victimName}`);
        //
        // update ingress
        //
        for (let i = 0; i < ingressUrls.length; i++) {
          const url = this.containers.hostContainerUrl(`n${i + 1}`, 8080);
          ingressUrls[i] = new URL(url);
        }
      }
    };

    killRestate().catch(console.error);

    let idempotencyKey = 1;
    for (const b of batch(this.generate(), 256)) {
      const promises = b.map(({ id, program }) => {
        idempotencyKey += 1;
        const key = `${idempotencyKey}`;
        return retry({
          op: () => {
            const server = Math.floor(Math.random() * ingressUrls.length);
            const url = ingressUrls[server];
            return sendInterpreter({
              ingressUrl: url,
              interpreterId: `${id}`,
              idempotencyKey: key,
              program,
            });
          },
          timeout: 1000,
          tag: `send ${key}`,
        });
      });

      b.forEach(({ id, program }) => this.stateTracker.update(0, id, program));
      try {
        await Promise.all(promises);
        console.log(`\x1b[33m Send ${b.length} programs \x1b[0m`);
      } catch (e) {
        console.error(e);
        throw e;
      }
    }

    this.status = TestStatus.VALIDATING;
    console.log("Done generating");

    const expected = this.stateTracker.getStates();
    const numInterpreters = this.conf.keys;
    const expectedTotal = expected.reduce((acc, layer) => {
      return acc + layer.reduce((acc, v) => acc + v, 0);
    }, 0);

    return verify({
      numInterpreters,
      adminUrl,
      expectedTotal,
      expected,
      cluster: this.containers,
    });
  }

  private async cleanup() {
    const c = this.containers;
    if (c) {
      this.containers = undefined;
      console.log("Cleaning up containers");
      await c.stop();
    }
  }
}

const verify = async ({
  numInterpreters,
  adminUrl,
  expectedTotal,
  expected,
  cluster,
}: {
  numInterpreters: number;
  adminUrl: () => string | undefined;
  expectedTotal: number;
  expected: number[][];
  cluster?: Cluster;
}) => {
  const verificationPhaseStartTime = new Date().getTime();
  let lastMillisecond = verificationPhaseStartTime;
  let lastCountDiff = numInterpreters;
  let lastTotalDiff = expectedTotal;

  // Watchdog state: the smallest total difference we've seen so far, and when
  // we last saw it shrink. If it stops shrinking for too long, the run is stuck.
  let bestTotalDiff = Number.POSITIVE_INFINITY;
  let lastProgressAt = verificationPhaseStartTime;
  let diagnosticsCollected = false;
  let pausedPolls = 0;

  while (true) {
    await sleep(10 * 1000);

    const { counters } = await retry({
      op: () => {
        const url = adminUrl(); // always use the latest url
        return getCounts({ adminUrl: url!, numInterpreters });
      },
      tag: "getCounts",
      timeout: 60_000,
      attempts: 10,
    });

    // Best-effort snapshot of interpreter invocation statuses. Used to surface
    // paused invocations (which never self-resolve) instead of silently waiting
    // out the no-progress timeout. A transient failure here just skips the check.
    let statusCounts: Record<string, number> = {};
    try {
      statusCounts = await getInvocationStatusCounts({ adminUrl: adminUrl()! });
    } catch (e) {
      console.warn("Could not fetch invocation status counts:", e);
    }
    const pausedCount = statusCounts["paused"] ?? 0;

    let countDiff = 0;
    let totalDiff = 0;
    let maxDiff = 0;

    for (let i = 0; i < expected.length; i++) {
      const n = expected[i].length;
      for (let j = 0; j < n; j++) {
        const d = expected[i][j] - counters[i][j];
        if (d !== 0) {
          countDiff += 1;
          totalDiff += Math.abs(d);
        }
        if (d > maxDiff) {
          maxDiff = d;
        }
      }
    }

    const nowDate = new Date();
    const now = new Date().toISOString();
    const nowMillis = nowDate.getTime();

    if (countDiff === 0) {
      console.log(`Done.`);
      return TestStatus.FINISHED;
    }

    const percentDone =
      ((expectedTotal - 1.0 * totalDiff) / expectedTotal) * 100;

    let remainingFormatted = "";
    if (percentDone > 0) {
      const needsMore = Math.ceil(
        (nowMillis - verificationPhaseStartTime) * (100.0 / percentDone),
      );
      const remaining = needsMore - (nowMillis - verificationPhaseStartTime);
      remainingFormatted = formatDuration(remaining);
    } else {
      remainingFormatted = "N/A";
    }

    console.log(
      `\x1b[31m ${now}\tVerification:
          =================================================================================

          Keys      differ:     ${countDiff}
          Total     difference: ${totalDiff}
          Settled   change:     ${countDiff - lastCountDiff}
          Total     change      ${totalDiff - lastTotalDiff}
          Max       difference: ${maxDiff}

          Percent done: ${percentDone.toFixed(2)}%
          Time elapsed: ${formatDuration(nowMillis - verificationPhaseStartTime)}
          Estimated time remaining: ${remainingFormatted}

          =================================================================================

          \x1b[0m`,
    );

    const statusStr =
      Object.entries(statusCounts)
        .map(([s, c]) => `${s}=${c}`)
        .join(", ") || "n/a";
    console.log(`          Invocation statuses: ${statusStr}`);

    lastMillisecond = nowMillis;
    lastCountDiff = countDiff;
    lastTotalDiff = totalDiff;

    // Shared fast-fail: dump diagnostics (including per-key journal/invocation
    // history) and abort the run with the given reason.
    const collectAndFail = async (reason: string) => {
      diagnosticsCollected = true;
      console.error(`\x1b[31m${reason} Collecting diagnostics.\x1b[0m`);
      await collectDiagnostics({
        cluster,
        adminUrl: adminUrl(),
        dumpGoroutines: STALL_DUMP_GOROUTINES,
        dumpDataDirs: STALL_DUMP_DATA_DIRS,
        differingKeys: computeDifferingKeys(expected, counters).slice(
          0,
          MAX_DIFFERING_KEYS_TO_DUMP,
        ),
      });
      throw new Error(`${reason} See diagnostics above.`);
    };

    // Paused invocations never self-resolve, so the verifier would hang forever.
    // Detect them directly and fail fast instead of waiting out the no-progress
    // timeout. Require persistence across a couple of polls to avoid transients.
    if (pausedCount > 0) {
      pausedPolls += 1;
    } else {
      pausedPolls = 0;
    }
    if (!diagnosticsCollected && pausedPolls >= PAUSED_CONFIRM_POLLS) {
      await collectAndFail(
        `Verification stuck: ${pausedCount} paused invocation(s) detected ` +
          `(${pausedPolls} consecutive polls) — paused invocations never ` +
          `self-resolve, so the counters can never converge.`,
      );
    }

    // Progress watchdog: track whether the total difference keeps shrinking.
    if (totalDiff < bestTotalDiff) {
      bestTotalDiff = totalDiff;
      lastProgressAt = nowMillis;
    }

    const stalledForMs = nowMillis - lastProgressAt;
    if (
      !STALL_DETECTOR_DISABLED &&
      !diagnosticsCollected &&
      stalledForMs >= STALL_TIMEOUT_SECONDS * 1000
    ) {
      await collectAndFail(
        `Verification stuck: no progress for ${formatDuration(stalledForMs)} ` +
          `with ${countDiff} keys (${totalDiff} total) still differing.`,
      );
    }
  }
};

function formatDuration(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}
