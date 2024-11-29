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
  ImagePullPolicy,
  Network,
  PullPolicy,
  StartedNetwork,
  StartedTestContainer,
} from "testcontainers";

export type ClusterSpec = {
  containers: ContainerSpec[];
};

export type ContainerSpec = {
  image: string;
  name: string;
  ports: number[];
  env?: Record<string, string>;
  pull: "always" | "never";
};

export type Container = {
  name: string;
  port(port: number): number;
  ports(): Record<number, number>;
  url(port: number): string;
  host(): string;
  stop(): Promise<void>;
  restart(): Promise<void>;
};

export type Cluster = {
  start(): Promise<void>;
  stop(): Promise<void>;
  container(name: string): Container;
  hostContainerUrl(name: string, port: number): string;
  internalContainerUrl(name: string, port: number): string;
};

export function createCluster(spec: ClusterSpec): Cluster {
  return new ConfiguredCluster(spec);
}

class ConfiguredContainer implements Container {
  private started: StartedTestContainer | undefined;

  constructor(
    private readonly spec: ContainerSpec,
    private readonly container: StartedTestContainer,
  ) {
    this.started = container;
  }

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
        acc[port] = started.getMappedPort(port);
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

  async stop() {
    if (this.started === undefined) {
      return;
    }
    await this.started.stop();
    this.started = undefined;
  }

  async restart() {
    if (this.started === undefined) {
      throw new Error("Container not started");
    }
    await this.started.restart({ timeout: 1 });
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

  async start(): Promise<void> {
    const network = await new Network().start();

    const neverPoll: ImagePullPolicy = {
      shouldPull: function (): boolean {
        return false;
      },
    };

    const containerPromises = this.spec.containers.map(async (spec) => {
      const container = new GenericContainer(spec.image)
        .withExposedPorts(...spec.ports)
        .withNetwork(network)
        .withNetworkAliases(spec.name)
        .withPullPolicy(
          spec.pull === "always" ? PullPolicy.alwaysPull() : neverPoll,
        )
        .withEnvironment(spec.env ?? {});

      const startedContainer = await container.start();

      return new ConfiguredContainer(spec, startedContainer);
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

    if (c) {
      const startedContainers = [...c.values()];
      const futures = startedContainers.map((c) => c.stop());
      await Promise.all(futures);
    }
    if (this.network) {
      await this.network.stop();
      this.network = undefined;
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
}
