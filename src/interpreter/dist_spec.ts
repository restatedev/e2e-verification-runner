// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import { ClusterSpec, ContainerSpec } from "./infra";

const RESTATE_ENV_JSON = process.env.UNIVERSE_ENV_JSON;

export const CLUSTER: ClusterSpec = (() => {
  if (RESTATE_ENV_JSON === undefined) {
    throw new Error("UNIVERSE_ENV_JSON is not set");
  }

  const universe = JSON.parse(RESTATE_ENV_JSON);
  const containers = Object.entries(universe).map(([key, value]) => {
    (value as any)["name"] = key;
    return value as ContainerSpec;
  });

  console.log(containers);

  return { containers };
})();
