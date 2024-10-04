// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import {
  interpreterDriver,
  interpreterDriverJob,
} from "./interpreter/entry_point";

const services = (process.env.SERVICES ?? "").split(",");

if (services.includes("InterpreterDriver")) {
  interpreterDriver();
} else if (services.includes("InterpreterDriverJob")) {
  interpreterDriverJob();
} else {
  throw new Error("Cannot find SERVICES env");
}
