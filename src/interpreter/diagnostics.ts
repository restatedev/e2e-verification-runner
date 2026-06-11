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

// How long to wait after sending SIGQUIT for the runtime to emit the goroutine
// stacks (into the container's log file) before cleanup stops the containers.
const GOROUTINE_DUMP_GRACE_MS = 4000;

// The interpreter virtual objects, indexed by layer (ObjectInterpreterL0/L1/L2).
const INTERPRETER_SERVICE = (layer: number) => `ObjectInterpreterL${layer}`;

// Extracts invocation ids from a /query result ({ rows: [{ id }] }).
function invocationIdsOf(data: unknown): string[] {
  const rows = (data as { rows?: Array<{ id?: string }> }).rows ?? [];
  return rows
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string");
}

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
  // whether to capture each runtime node's restate-data dir. This gracefully
  // stops the nodes (killing the admin API), so it is the last diagnostic step
  // and only appropriate once the run is being aborted.
  dumpDataDirs: boolean;
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

    await safe(`invocations for key ${service}/${key}`, async () => {
      const data = await queryRestate(
        adminUrl,
        `select id, target, status, completed_at, invoked_by, invoked_by_id, invoked_by_target ` +
          `from sys_invocation ` +
          `where target_service_name = '${service}' and target_service_key = '${key}' ` +
          `limit 50`,
      );
      console.log("invocations:", JSON.stringify(data, null, 2));
    });
    // Journals are dumped for all non-completed invocations (see
    // collectDiagnostics), not per differing key.
  }
}

/**
 * Collects everything we need to tell apart an SDK-side hang from a
 * runtime-side hang on a wedged verification run:
 *
 *  1. the set of not-yet-completed invocations and what they are waiting on,
 *     plus per-key state/journal (from the restate admin API), and
 *  2. for Go runs, a SIGQUIT to each SDK service container so it emits a
 *     goroutine dump into its (separately captured) container log file.
 *
 * Every step is best-effort: a failure in one does not prevent the others.
 */
export async function collectDiagnostics(
  opts: DiagnosticsOptions,
): Promise<void> {
  const { cluster, adminUrl, dumpGoroutines, dumpDataDirs, differingKeys } =
    opts;

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

    let nonCompletedIds: string[] = [];
    await safe("non-completed invocations", async () => {
      banner("non-completed invocations (sys_invocation)");
      const data = await queryNonCompletedInvocations(adminUrl);
      console.log(JSON.stringify(data, null, 2));
      nonCompletedIds = invocationIdsOf(data);
    });

    // Journal for each non-completed (stuck) invocation, fetched individually
    // so we cover all of them without a giant IN clause. Filtering sys_journal
    // by its `id` column avoids joining with sys_invocation, which builds large
    // in-memory hash tables and exhausts Datafusion's memory pool.
    await safe("journals for non-completed invocations", async () => {
      banner(
        `journals for ${nonCompletedIds.length} non-completed invocations (sys_journal)`,
      );
      for (const id of nonCompletedIds) {
        try {
          const data = await queryRestate(
            adminUrl,
            `select id, "index", entry_type, name, completed, invoked_target, entry_json ` +
              `from sys_journal where id = '${id}' order by "index" limit 5000`,
          );
          console.log(`journal ${id}:`, JSON.stringify(data, null, 2));
        } catch (e) {
          console.error(`[diagnostics] failed to fetch journal for ${id}:`, e);
        }
      }
    });

    // Follow the pending calls. A suspended caller whose journal has a
    // "Command: Call" but no matching "Notification: Call" is waiting on the
    // result of a call it made. The callee is found via invoked_by_id; dumping
    // its status shows whether the callee is itself stuck or already completed
    // (i.e. the result notification was lost).
    const calleeIds = new Set<string>();
    await safe("callees of non-completed invocations", async () => {
      banner("callees of non-completed invocations (sys_invocation)");
      for (const id of nonCompletedIds) {
        try {
          const data = await queryRestate(
            adminUrl,
            `select id, target, status, completed_at, invoked_by_id ` +
              `from sys_invocation where invoked_by_id = '${id}'`,
          );
          console.log(`callees of ${id}:`, JSON.stringify(data, null, 2));
          for (const callee of invocationIdsOf(data)) {
            calleeIds.add(callee);
          }
        } catch (e) {
          console.error(`[diagnostics] failed to fetch callees of ${id}:`, e);
        }
      }
    });

    // Journals for callees we haven't already dumped — in particular callees
    // that completed but whose result notification the caller never received.
    await safe("journals for callee invocations", async () => {
      const newCallees = [...calleeIds].filter(
        (id) => !nonCompletedIds.includes(id),
      );
      banner(
        `journals for ${newCallees.length} callee invocation(s) not already dumped (sys_journal)`,
      );
      for (const id of newCallees) {
        try {
          const data = await queryRestate(
            adminUrl,
            `select id, "index", entry_type, name, completed, invoked_target, entry_json ` +
              `from sys_journal where id = '${id}' order by "index" limit 5000`,
          );
          console.log(`journal ${id}:`, JSON.stringify(data, null, 2));
        } catch (e) {
          console.error(`[diagnostics] failed to fetch journal for ${id}:`, e);
        }
      }
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

  // Container logs are streamed to per-container files and uploaded as
  // artifacts (see CONTAINER_LOGS_DIR in infra.ts), so we don't tail them here.
  // For Go services we still SIGQUIT to trigger a goroutine dump; it goes to the
  // process's stderr, which is captured in that container's own log file.
  if (dumpGoroutines) {
    for (const name of sdkServices) {
      await safe(`SIGQUIT to ${name}`, async () => {
        console.log(
          `[diagnostics] sent SIGQUIT to ${name} for a goroutine dump ` +
            `(captured in its container log file)`,
        );
        await cluster.container(name).signal("SIGQUIT");
      });
    }
    // Let the runtime emit the stacks before cleanup stops the containers and
    // closes the log files.
    await new Promise((r) => setTimeout(r, GOROUTINE_DUMP_GRACE_MS));
  } else {
    console.log(
      "[diagnostics] goroutine dumps disabled (set STUCK_DETECTOR_DUMP_GOROUTINES=true to enable)",
    );
  }

  console.log(`[diagnostics] restate nodes: ${restateNodes.join(", ")}`);
  console.log(`[diagnostics] sdk services: ${sdkServices.join(", ")}`);

  // Capture each runtime node's restate-data dir (RocksDB/metadata) so it can be
  // inspected post-mortem. This MUST be last: we gracefully stop every node
  // first to freeze its on-disk state (compatibility configs share one bind
  // mount, so a still-running node would mutate the dir we're copying), which
  // also kills the admin API used by the queries above. Then we copy each
  // (now stopped) node's data dir into the uploaded container-logs dir.
  if (dumpDataDirs) {
    banner("restate-data capture");
    for (const name of restateNodes) {
      await safe(`stopping ${name} for data capture`, async () => {
        console.log(
          `[diagnostics] gracefully stopping ${name} to freeze its data dir`,
        );
        await cluster.container(name).freezeForDataCapture();
      });
    }
    for (const name of restateNodes) {
      await safe(`restate-data dir for ${name}`, async () => {
        console.log(
          `[diagnostics] capturing ${name} restate-data -> restate-data-${name}.tar`,
        );
        await cluster.container(name).copyDataDir();
      });
    }
  } else {
    console.log(
      "[diagnostics] restate-data capture disabled " +
        "(set STUCK_DETECTOR_DUMP_DATA=true to enable)",
    );
  }

  banner("END");
}
