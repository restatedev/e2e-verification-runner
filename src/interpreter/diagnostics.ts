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
// Goroutine dumps can be large (one stack per leaked goroutine), so grab more
// lines and read the stream a bit longer than for ordinary log tails.
const GOROUTINE_DUMP_TAIL_LINES = 50000;
const GOROUTINE_DUMP_READ_WINDOW_MS = 8000;
// How long to wait after sending SIGQUIT before grabbing the goroutine dump.
const GOROUTINE_DUMP_GRACE_MS = 4000;

// The interpreter virtual objects, indexed by layer (ObjectInterpreterL0/L1/L2).
const INTERPRETER_SERVICE = (layer: number) => `ObjectInterpreterL${layer}`;

/**
 * Runs a single SQL query against the restate admin introspection API and
 * returns the parsed JSON. See the schema at
 * https://docs.restate.dev/references/sql-introspection.
 */
async function queryRestate(adminUrl: string, sql: string): Promise<unknown> {
  const res = await fetch(`${adminUrl}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export interface DifferingKey {
  layer: number;
  key: number;
  expected: number;
  actual: number;
}

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
  // the interpreter keys whose counter does not match the expected value. For
  // each of these we dump the object's state, invocation history and journal so
  // we can localize a lost (or extra) increment.
  differingKeys?: DifferingKey[];
}

/**
 * For each differing interpreter key, dumps the current state, the invocation
 * history (all statuses, not just non-completed), the journal, and the
 * idempotency mapping for that virtual object. This is what lets us localize a
 * lost increment: it shows whether the responsible invocation ran, what it
 * journaled, and whether the increment entry is present.
 *
 * The journal/invocation history is only available if retention was enabled for
 * the interpreter services (see INTERPRETER_JOURNAL_RETENTION); otherwise these
 * queries return empty for already-completed invocations.
 */
async function dumpDifferingKeys(
  adminUrl: string,
  differingKeys: DifferingKey[],
): Promise<void> {
  banner(`differing keys (${differingKeys.length})`);
  for (const d of differingKeys) {
    const service = INTERPRETER_SERVICE(d.layer);
    const key = String(d.key);
    console.log(
      `\n[diagnostics] ${service} key=${key}: expected=${d.expected} actual=${d.actual} (diff=${d.expected - d.actual})`,
    );

    await safe(`state for key ${service}/${key}`, async () => {
      const data = await queryRestate(
        adminUrl,
        `select service_name, service_key, key, value_utf8 from state where service_name = '${service}' and service_key = '${key}'`,
      );
      console.log("state:", JSON.stringify(data, null, 2));
    });

    let invocationIds: string[] = [];
    await safe(`invocations for key ${service}/${key}`, async () => {
      const data = await queryRestate(
        adminUrl,
        `select id, target, status, completed_at, invoked_by, invoked_by_id, invoked_by_target ` +
          `from sys_invocation ` +
          `where target_service_name = '${service}' and target_service_key = '${key}' ` +
          `limit 50`,
      );
      console.log("invocations:", JSON.stringify(data, null, 2));
      const rows = (data as { rows?: Array<{ id?: string }> }).rows ?? [];
      invocationIds = rows
        .map((r) => r.id)
        .filter((id): id is string => typeof id === "string");
    });

    // Journal for those invocations. We filter sys_journal by invocation id
    // (its `id` column) rather than joining sys_journal with sys_invocation:
    // the join builds large in-memory hash tables and exhausts Datafusion's
    // memory pool ("Resources exhausted"). A plain IN filter is a simple scan.
    await safe(`journal for key ${service}/${key}`, async () => {
      if (invocationIds.length === 0) {
        console.log("journal: (no invocations found for this key)");
        return;
      }
      const ids = invocationIds.map((id) => `'${id}'`).join(", ");
      const data = await queryRestate(
        adminUrl,
        `select id, "index", entry_type, name, completed, invoked_target, entry_json ` +
          `from sys_journal where id in (${ids}) order by id, "index" limit 5000`,
      );
      console.log("journal:", JSON.stringify(data, null, 2));
    });
  }
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
  const { cluster, adminUrl, dumpGoroutines, differingKeys } = opts;

  banner("BEGIN");

  if (adminUrl) {
    await safe("invocation status histogram", async () => {
      banner("invocation status histogram (sys_invocation)");
      const data = await queryRestate(
        adminUrl,
        `select status, count(*) as count from sys_invocation ` +
          `where target_service_name like 'ObjectInterpreter%' ` +
          `or target_service_name = 'ServiceInterpreterHelper' ` +
          `group by status`,
      );
      console.log(JSON.stringify(data, null, 2));
    });

    await safe("non-completed invocations", async () => {
      banner("non-completed invocations (sys_invocation)");
      const data = await queryNonCompletedInvocations(adminUrl);
      console.log(JSON.stringify(data, null, 2));
    });

    if (differingKeys && differingKeys.length > 0) {
      await safe("differing keys", () =>
        dumpDifferingKeys(adminUrl, differingKeys),
      );
    }
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

  // Tail container logs. When we're going to dump goroutines, the SDK service
  // containers are tailed (with their dump) in the goroutine section below, so
  // we only tail the restate nodes here to avoid logging them twice. Without a
  // goroutine dump, tail everything here.
  const logContainers = dumpGoroutines ? restateNodes : names;
  for (const name of logContainers) {
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
        console.log(
          await cluster
            .container(name)
            .tailLogs(GOROUTINE_DUMP_TAIL_LINES, GOROUTINE_DUMP_READ_WINDOW_MS),
        );
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
