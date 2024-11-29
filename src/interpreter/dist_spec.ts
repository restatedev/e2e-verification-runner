// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import { ClusterSpec, ContainerSpec } from "./infra";

const RESTATE_IMAGE =
  process.env.RESTATE_IMAGE ?? "ghcr.io/restatedev/restate:main";

const SDK_IMAGE =
  process.env.SDK_IMAGE ?? "localhost/restatedev/test-services:latest";

export const RESTATE_LEADER: ContainerSpec = {
  image: RESTATE_IMAGE,
  name: "n1",
  ports: [8080, 9070, 5122, 5123],
  pull: "always",
  env: {
    RESTATE_LOG_FILTER: "restate=warn",
    RESTATE_LOG_FORMAT: "json",
    RESTATE_ROLES: "[worker,log-server,admin,metadata-store]",
    RESTATE_CLUSTER_NAME: "foobar",
    RESTATE_BIFROST__DEFAULT_PROVIDER: "replicated",
    RESTATE_ALLOW_BOOTSTRAP: "true",
    RESTATE_ADVERTISED_ADDRESS: "http://n1:5122",
  },
};

export const RESTATE_FOLLOWER = (n: number): ContainerSpec => {
  const name = `n${n + 2}`; // followers start at 2, leader is 1.
  return {
    image: RESTATE_IMAGE,
    name,
    ports: [8080],
    pull: "always",
    env: {
      RESTATE_LOG_FILTER: "restate=warn",
      RESTATE_LOG_FORMAT: "json",
      RESTATE_ROLES: "[worker,admin,log-server]",
      RESTATE_CLUSTER_NAME: "foobar",
      RESTATE_BIFROST__DEFAULT_PROVIDER: "replicated",
      RESTATE_ALLOW_BOOTSTRAP: "true",
      RESTATE_METADATA_STORE_CLIENT__ADDRESS: "http://n1:5123",
      RESTATE_ADVERTISED_ADDRESS: `http://${name}:5122`,
    },
  };
};

export const INTERPRETER = (n: number): ContainerSpec => {
  let english: string;
  switch (n) {
    case 0:
      english = "zero";
      break;
    case 1:
      english = "one";
      break;
    case 2:
      english = "two";
      break;
    default:
      throw new Error("Invalid interpreter number");
  }
  const name = `interpreter_${english}`;
  return {
    image: SDK_IMAGE,
    name,
    ports: [9000 + n],
    pull: "never",
    env: {
      PORT: `${9000 + n}`,
      RESTATE_LOGGING: "ERROR",
      NODE_ENV: "production",
      SERVICES: `ObjectInterpreterL${n}`,
    },
  };
};

export const SERVICES: ContainerSpec = {
  image: SDK_IMAGE,
  name: "services",
  ports: [9003],
  pull: "never",
  env: {
    PORT: "9003",
    RESTATE_LOGGING: "ERROR",
    NODE_ENV: "production",
    SERVICES: "ServiceInterpreterHelper",
  },
};

export const CLUSTER: ClusterSpec = (() => {
  const containers = [];

  containers.push(RESTATE_LEADER);

  for (let i = 0; i < 2; i++) {
    containers.push(RESTATE_FOLLOWER(i));
  }

  containers.push(INTERPRETER(0));
  containers.push(INTERPRETER(1));
  containers.push(INTERPRETER(2));
  containers.push(SERVICES);

  return { containers };
})();
