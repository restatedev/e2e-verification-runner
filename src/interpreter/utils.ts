// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

export function* batch<T>(iterable: IterableIterator<T>, batchSize: number) {
  let items: T[] = [];
  for (const item of iterable) {
    items.push(item);
    if (items.length >= batchSize) {
      yield items;
      items = [];
    }
  }
  if (items.length !== 0) {
    yield items;
  }
}

export function* iterate(arr: number[]) {
  for (let j = 0; j < arr.length; j++) {
    const expected = arr[j];
    const id = j;
    yield { id, expected };
  }
}

export const sleep = (duration: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, duration));

export const timeout = <T>(duration: number): Promise<T> =>
  new Promise((_resolve, rejected) =>
    setTimeout(() => rejected("timeout"), duration),
  );

export type RetryOptions<T> = {
  timeout?: number;
  tag: string;
  op: () => Promise<T>;
};

export const retry = async <T>(opts: RetryOptions<T>): Promise<T> => {
  let error;
  const ts = opts.timeout ?? 10_000;
  for (let i = 0; i < 360; i++) {
    try {
      return await Promise.race([opts.op(), timeout<T>(ts)]);
    } catch (e) {
      console.log("retrying", opts.tag, e);
      error = e;
      await sleep(10_000);
    }
  }
  throw error;
};
