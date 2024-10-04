// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import * as restate from "@restatedev/restate-sdk-clients";
import { Program } from "./commands";

export type InterpreterId = {
  readonly layer: number;
  readonly key: string;
};

export const interpreterObjectForLayer = (
  layer: number,
): restate.VirtualObjectDefinition<string, InterpreterObject> => {
  const name = `ObjectInterpreterL${layer}`;
  return { name };
};

interface InterpreterObject {
  counter(ctx: unknown): Promise<number>;
  interpret(ctx: unknown, program: Program): Promise<void>;
}
