// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import { Cluster } from "./infra";

// restate server nodes are named n1, n2, n3, ...
const RESTATE_NODE_NAME = /^n\d+$/;

// How many log lines to grab per container.
const LOG_TAIL_LINES = 5000;
// How long to wait after sending SIGQUIT before grabbing the goroutine dump.
const GOROUTINE_DUMP_GRACE_MS = 4000;

/**
 * Queries the restate introspection API for every invocation that has not yet
 * completed. For a wedged run this is the single most decisive piece of
 * evidence: it shows which invocations are stuck, in which state (e.g.
 * `suspended`, `backing-off`), what they are waiting on
 * (`suspended_waiting_for_completions` / `_signals`), the caller chain
 * (`invoked_by*`), and the last failure, if any.
 *
 * See https://docs.restate.dev/references/sql-introspection for the schema.
 */
export async function queryNonCompletedInvocations(
  adminUrl: string,
): Promise<unknown> {
  const query = `select
      id,
      target,
      status,
      invoked_by,
      invoked_by_id,
      invoked_by_target,
      suspended_waiting_for_completions,
      suspended_waiting_for_signals,
      retry_count,
      next_retry_at,
      modified_at,
      last_attempt_deployment_id,
      last_attempt_server,
      last_failure_error_code,
      last_failure,
      last_failure_related_command_name,
      last_failure_related_command_type
    from sys_invocation
    where status != 'completed'
    limit 1000`;

  const res = await fetch(`${adminUrl}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(
      `sys_invocation query failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[diagnostics] failed to collect ${label}:`, e);
  }
}

function banner(title: string) {
  console.log(
    `\n===================== DIAGNOSTICS: ${title} =====================`,
  );
}

export interface DiagnosticsOptions {
  cluster?: Cluster;
  adminUrl?: string;
  // whether to SIGQUIT the Go SDK service containers to obtain goroutine dumps.
  // this crashes those processes, so it is only appropriate once we've decided
  // the run is wedged and is going to be aborted.
  dumpGoroutines: boolean;
}

/**
 * Collects everything we need to tell apart an SDK-side hang from a
 * runtime-side hang on a wedged verification run:
 *
 *  1. the set of not-yet-completed invocations and what they are waiting on
 *     (from the restate admin API), and
 *  2. a full goroutine dump of every Go SDK service container (via SIGQUIT),
 *     plus a tail of every container's logs.
 *
 * Every step is best-effort: a failure in one does not prevent the others.
 */
export async function collectDiagnostics(
  opts: DiagnosticsOptions,
): Promise<void> {
  const { cluster, adminUrl, dumpGoroutines } = opts;

  banner("BEGIN");

  if (adminUrl) {
    await safe("non-completed invocations", async () => {
      banner("non-completed invocations (sys_invocation)");
      const data = await queryNonCompletedInvocations(adminUrl);
      console.log(JSON.stringify(data, null, 2));
    });
  } else {
    console.log("[diagnostics] no admin url available, skipping invocations");
  }

  if (!cluster) {
    console.log("[diagnostics] no cluster available, skipping container dumps");
    banner("END");
    return;
  }

  const names = cluster.containerNames();
  const restateNodes = names.filter((n) => RESTATE_NODE_NAME.test(n));
  const sdkServices = names.filter((n) => !RESTATE_NODE_NAME.test(n));

  // Tail logs of everything first, so we capture state before we start
  // crashing things.
  for (const name of names) {
    await safe(`logs of ${name}`, async () => {
      banner(`container logs: ${name} (id=${cluster.container(name).id()})`);
      console.log(await cluster.container(name).tailLogs(LOG_TAIL_LINES));
    });
  }

  if (dumpGoroutines) {
    // SIGQUIT makes the Go runtime print stacks of all goroutines and exit.
    // We send it to all SDK services first, then read their logs, so they can
    // dump in parallel.
    for (const name of sdkServices) {
      await safe(`SIGQUIT to ${name}`, async () => {
        console.log(
          `[diagnostics] sending SIGQUIT to ${name} for goroutine dump`,
        );
        await cluster.container(name).signal("SIGQUIT");
      });
    }

    await new Promise((r) => setTimeout(r, GOROUTINE_DUMP_GRACE_MS));

    for (const name of sdkServices) {
      await safe(`goroutine dump of ${name}`, async () => {
        banner(`goroutine dump: ${name}`);
        console.log(await cluster.container(name).tailLogs(LOG_TAIL_LINES));
      });
    }
  } else {
    console.log(
      "[diagnostics] goroutine dumps disabled (STUCK_DETECTOR_DUMP_GOROUTINES=false)",
    );
  }

  console.log(`[diagnostics] restate nodes: ${restateNodes.join(", ")}`);
  console.log(`[diagnostics] sdk services: ${sdkServices.join(", ")}`);

  banner("END");
}
