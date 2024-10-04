// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import { createServer, createJob } from "./driver";

export function interpreterDriver() {
  const port = process.env.INTERPRETER_DRIVER_PORT ?? "3000";
  createServer(parseInt(port));
}

export function interpreterDriverJob() {
  let done = false;

  createJob()
    .then((status) => {
      console.log(`Job success! ${status}`);
      process.exit(0);
    })
    .catch((e) => {
      console.log(`Job failure ${e}`);
      process.exit(1);
    })
    .finally(() => {
      done = true;
    });

  (function wait() {
    // prevent node from exiting
    if (!done) setTimeout(wait, 1000);
  })();
} 