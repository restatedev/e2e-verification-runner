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
import { getCounts, sendInterpreter } from "./raw_client";

const MAX_LAYERS = 3;

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
}: {
  numInterpreters: number;
  adminUrl: () => string | undefined;
  expectedTotal: number;
  expected: number[][];
}) => {
  const verificationPhaseStartTime = new Date().getTime();
  let lastMillisecond = verificationPhaseStartTime;
  let lastCountDiff = numInterpreters;
  let lastTotalDiff = expectedTotal;

  while (true) {
    await sleep(10 * 1000);

    const { counters } = await retry({
      op: () => {
        const url = adminUrl(); // always use the latest url
        return getCounts({ adminUrl: url!, numInterpreters });
      },
      tag: "getCounts",
      timeout: 10_000,
    });

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

    lastMillisecond = nowMillis;
    lastCountDiff = countDiff;
    lastTotalDiff = totalDiff;
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
