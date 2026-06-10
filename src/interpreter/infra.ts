// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import {
  GenericContainer,
  getContainerRuntimeClient,
  ImagePullPolicy,
  Network,
  PortWithOptionalBinding,
  PullPolicy,
  StartedNetwork,
  StartedTestContainer,
  StoppedTestContainer,
} from "testcontainers";
import { createWriteStream, WriteStream } from "fs";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { TestConfigurationRollingUpgrade } from "./test_driver";

// Directory (inside the driver container) where each container's full log is
// streamed to `<name>.log`. Mounted to a host dir and uploaded as a CI artifact.
// Unset => no per-container log capture.
const CONTAINER_LOGS_DIR = process.env.CONTAINER_LOGS_DIR;

// Default location of the restate data directory inside a runtime container.
// Used by copyDataDir() when a container has no explicit data bind mount.
const DEFAULT_DATA_DIR = "/restate-data";

// Pipe a container's (demuxed) log stream to its file. `end: false` so a
// container stop/restart/roll doesn't close the shared file — we end it
// ourselves on stop().
function attachLogStream(
  builder: GenericContainer,
  stream: WriteStream | undefined,
): void {
  if (stream) {
    builder.withLogConsumer((s) => s.pipe(stream, { end: false }));
  }
}

export type ClusterSpec = {
  containers: ContainerSpec[];
};

export type ContainerSpec = {
  // the latest version of the image is used
  image: string;
  // an ordered list of images, from oldest to newest.
  // this is only relevant for rolling upgrades tests.
  // depending on the mode of the rolling upgrade test, the test will
  // traverse the list of images in the order specified.
  images?: string[];
  // the container name
  name: string;
  // expose the following ports to the host
  // this list can contain numbers (for exposing a single port)
  // or strings (for exposing a port and mapping it to a host port)
  // in the format "host:container"
  ports: (number | string)[];
  // environment variables to pass to the container
  env?: Record<string, string>;
  // pull the image always or never
  pull: "always" | "never";
  // use the following command when starting the container
  cmd?: string[];
  // use entry point when starting the container
  entryPoint?: string[];
  // mount the following volumes (always rw mode)
  mount?: { source: string; target: string }[];
};

export type Container = {
  name: string;
  port(port: number): number;
  ports(): Record<number, number>;
  url(port: number): string;
  host(): string;
  // the underlying docker container id
  id(): string;
  // send a unix signal (e.g. "SIGQUIT") to the container's main process
  signal(signal: string): Promise<void>;
  stop(): Promise<void>;
  // Gracefully stop the container WITHOUT removing it, so its data dir is frozen
  // and consistent (the runtime flushes its WAL and closes RocksDB cleanly) and
  // can be copied afterwards by copyDataDir().
  freezeForDataCapture(): Promise<void>;
  // Copy the restate data dir out of the (now stopped) container into the
  // uploaded container-logs dir as restate-data-<name>.tar.gz. No-op if
  // CONTAINER_LOGS_DIR is unset (nothing would be uploaded).
  copyDataDir(): Promise<void>;
  restart(): Promise<void>;
  restartAndWipeData(): Promise<void>;
  // returns true if the rolling upgrade/downgrade was successful
  // unsuccessful if there are no more images to roll to.
  // throws (rejects) if anything goes wrong.
  rollImage(): Promise<boolean>;
};

export type Cluster = {
  start(upgrade: TestConfigurationRollingUpgrade): Promise<void>;
  stop(): Promise<void>;
  container(name: string): Container;
  // names of all containers in the cluster
  containerNames(): string[];
  hostContainerUrl(name: string, port: number): string;
  internalContainerUrl(name: string, port: number): string;
};

export function createCluster(spec: ClusterSpec): Cluster {
  return new ConfiguredCluster(spec);
}

class ConfiguredContainer implements Container {
  // Set by freezeForDataCapture(): the stopped-but-not-removed container, kept
  // around so copyDataDir() can read its (now frozen) filesystem.
  private stopped?: StoppedTestContainer;

  constructor(
    private readonly spec: ContainerSpec,
    private readonly restContainers: [string, GenericContainer][],
    private started: StartedTestContainer | undefined,
    private readonly mode: "none" | "forward" | "backward" | "random",
    private readonly logStream?: WriteStream,
  ) {}

  get name() {
    return this.spec.name;
  }

  port(port: number): number {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    return this.started.getMappedPort(port);
  }

  ports(): Record<number, number> {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    const started = this.started;
    return this.spec.ports.reduce(
      (acc, port) => {
        if (typeof port === "number") {
          acc[port] = started.getMappedPort(port);
        } else {
          // Handle "host:container" format
          const [hostPort, containerPort] = port
            .split(":")
            .map((p) => parseInt(p, 10));
          acc[containerPort] = hostPort;
        }
        return acc;
      },
      {} as Record<number, number>,
    );
  }

  url(port: number): string {
    return `http://${this.host()}:${this.port(port)}`;
  }

  host(): string {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    return this.started.getHost();
  }

  id(): string {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    return this.started.getId();
  }

  async signal(signal: string): Promise<void> {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    const client = await getContainerRuntimeClient();
    const dockerContainer = client.container.getById(this.started.getId());
    // dockerode types `kill` options as `{}`, but it forwards `signal` to the
    // docker kill API (?signal=...), which is exactly what we need.
    await dockerContainer.kill({ signal } as Record<string, unknown>);
  }

  async stop() {
    if (this.started !== undefined) {
      await this.started.stop();
      this.started = undefined;
    }
    this.logStream?.end();
  }

  async freezeForDataCapture(): Promise<void> {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    // SIGTERM => restate flushes its WAL and closes RocksDB cleanly. Keep the
    // container (remove: false) so copyDataDir() can read its filesystem. Don't
    // end logStream here — cluster.stop() does that during normal cleanup.
    this.stopped = await this.started.stop({ remove: false, timeout: 30 });
    this.started = undefined;
  }

  async copyDataDir(): Promise<void> {
    if (!CONTAINER_LOGS_DIR) {
      return; // nowhere to write / nothing uploaded
    }
    const source = this.stopped ?? this.started;
    if (source === undefined) {
      throw new Error("Container not available");
    }
    const dataDir = this.spec.mount?.[0]?.target ?? DEFAULT_DATA_DIR;
    const tar = await source.copyArchiveFromContainer(dataDir);
    const out = createWriteStream(
      `${CONTAINER_LOGS_DIR}/restate-data-${this.spec.name}.tar.gz`,
    );
    await pipeline(tar, createGzip(), out);
  }

  async restart() {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    await this.started.restart({ timeout: 1 });
  }

  async rollImage(): Promise<boolean> {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    let next: [string, GenericContainer] | undefined = undefined;
    switch (this.mode) {
      case "forward": {
        next = this.restContainers.shift();
        break;
      }
      case "backward": {
        next = this.restContainers.pop();
        break;
      }
      case "random": {
        const index = Math.floor(Math.random() * this.restContainers.length);
        next = this.restContainers[index];
        break;
      }
      case "none": {
        next = undefined;
        break;
      }
    }
    if (next === undefined) {
      return false;
    }
    const [nextImage, nextContainer] = next;
    console.log(
      `Rolling upgrade ${this.name} to ${nextImage} (mode: ${this.mode})`,
    );
    await this.started.stop({
      remove: true,
    });
    this.started = await nextContainer.start();
    return true;
  }

  async restartAndWipeData() {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }

    const now = new Date().getTime();

    await this.started.exec(["sh", "-c", `mkdir -p /ohoh/${now}`]);
    await this.started.exec([
      "sh",
      "-c",
      `cp -r /restate-data/*/db /ohoh/${now}/db`,
    ]);
    await this.started.exec(["sh", "-c", "rm -rf /restate-data/*/db"]);
    await this.started.restart({ timeout: 1 });
  }
}

/**
 * Extract the upgrade policy for a container.
 */
function upgradePolicy(
  rollingUpgrade: TestConfigurationRollingUpgrade,
  spec: ContainerSpec,
):
  | { mode: "none"; image: string; images: string[] }
  | { mode: "forward"; image: string; images: string[] }
  | { mode: "backward"; image: string; images: string[] }
  | { mode: "random"; image: string; images: string[] } {
  const mode = rollingUpgrade[spec.name];
  if (mode === undefined) {
    return { mode: "none", image: spec.image, images: [] };
  }
  if (spec.images === undefined) {
    throw new Error(
      `Container ${spec.name} has no images for rolling upgrade, but you specified a rolling upgrade test for this container.`,
    );
  }
  switch (mode) {
    case "forward": {
      return { mode: "forward", image: spec.images[0], images: spec.images };
    }
    case "backward": {
      return {
        mode: "backward",
        image: spec.images[spec.images.length - 1],
        images: spec.images,
      };
    }
    case "random": {
      const index = Math.floor(Math.random() * spec.images.length);
      const image = spec.images[index];
      return { mode: "random", image, images: spec.images };
    }
    default:
      throw new Error(`Unknown rolling upgrade mode: ${mode}`);
  }
}

class ConfiguredCluster implements Cluster {
  private containers: Map<string, ConfiguredContainer> | undefined;
  private network: StartedNetwork | undefined;

  constructor(private readonly spec: ClusterSpec) {}

  hostContainerUrl(name: string, port: number): string {
    if (this.containers === undefined) {
      throw new Error("Cluster not started");
    }
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`Container ${name} not found`);
    }
    return container.url(port);
  }

  internalContainerUrl(name: string, port: number): string {
    if (this.containers === undefined) {
      throw new Error("Cluster not started");
    }
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`Container ${name} not found`);
    }
    return `http://${container.host()}:${port}`;
  }

  async start(rollingUpgrade: TestConfigurationRollingUpgrade): Promise<void> {
    const network = await new Network().start();

    const neverPoll: ImagePullPolicy = {
      shouldPull: function (): boolean {
        return false;
      },
    };

    const containerPromises = this.spec.containers.map(async (spec) => {
      const { mode, image, images } = upgradePolicy(rollingUpgrade, spec);

      const logStream = CONTAINER_LOGS_DIR
        ? createWriteStream(`${CONTAINER_LOGS_DIR}/${spec.name}.log`, {
            flags: "a",
          })
        : undefined;

      let ports: PortWithOptionalBinding[] = spec.ports.map((port) => {
        if (typeof port === "number") {
          return port;
        } else {
          const [host, container] = port
            .split(":", 2)
            .map((p) => parseInt(p, 10));

          return {
            host: host,
            container: container,
          };
        }
      });

      const container = new GenericContainer(image)
        .withExposedPorts(...ports)
        .withNetwork(network)
        .withNetworkAliases(spec.name)
        .withName(spec.name)
        .withPullPolicy(
          spec.pull === "always" ? PullPolicy.alwaysPull() : neverPoll,
        )
        .withEnvironment(spec.env ?? {});

      if (spec.cmd) {
        container.withCommand(spec.cmd);
      }
      if (spec.entryPoint) {
        container.withEntrypoint(spec.entryPoint);
      }
      if (spec.mount) {
        container.withBindMounts(
          spec.mount.map((m) => {
            return { source: m.source, target: m.target, mode: "rw" };
          }),
        );
      }
      attachLogStream(container, logStream);

      const restContainers: [string, GenericContainer][] = images.map(
        (image) => {
          const restContainer = new GenericContainer(image)
            .withExposedPorts(...ports)
            .withNetwork(network)
            .withNetworkAliases(spec.name)
            .withName(spec.name)
            .withPullPolicy(
              spec.pull === "always" ? PullPolicy.alwaysPull() : neverPoll,
            )
            .withEnvironment(spec.env ?? {});

          if (spec.cmd) {
            restContainer.withCommand(spec.cmd);
          }
          if (spec.entryPoint) {
            restContainer.withEntrypoint(spec.entryPoint);
          }
          if (spec.mount) {
            restContainer.withBindMounts(
              spec.mount.map((m) => {
                return { source: m.source, target: m.target, mode: "rw" };
              }),
            );
          }
          attachLogStream(restContainer, logStream);

          return [image, restContainer];
        },
      );

      const startedContainer = await container.start();
      return new ConfiguredContainer(
        spec,
        restContainers,
        startedContainer,
        mode,
        logStream,
      );
    });

    const containers = await Promise.all(containerPromises);

    this.network = network;
    this.containers = containers.reduce((acc, container) => {
      acc.set(container.name, container);
      return acc;
    }, new Map<string, ConfiguredContainer>());
  }

  async stop(): Promise<void> {
    const c = this.containers;
    this.containers = undefined;

    const n = this.network;
    this.network = undefined;

    if (process.env.DISABLE_CLEANUP) {
      console.log("Skipping stop of containers");
      return;
    }

    if (c) {
      const startedContainers = [...c.values()];
      console.log(
        "Stopping containers",
        startedContainers.map((c) => c.name),
      );
      const futures = startedContainers.map((c) => c.stop());
      await Promise.all(futures);
    }

    if (n) {
      await n.stop();
    }
  }

  container(name: string): Container {
    if (this.containers === undefined) {
      throw new Error("Cluster not started");
    }
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`Container ${name} not found`);
    }
    return container;
  }

  containerNames(): string[] {
    if (this.containers === undefined) {
      throw new Error("Cluster not started");
    }
    return [...this.containers.keys()];
  }
}
