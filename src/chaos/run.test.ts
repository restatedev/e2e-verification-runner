import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";
import {
  Experiment,
  injected,
  jobOutcome,
  render,
  settings,
  victims,
} from "./spec";

// Compiled tests live in dist/chaos; the suite files live at the repository root.
const suite = resolve(__dirname, "../../chaos");

test("only complete, in-scope fault records count as injection evidence", () => {
  const experiment: Experiment = {
    kind: "PodChaos",
    metadata: { name: "kill", uid: "1" },
    status: {
      experiment: {
        containerRecords: [
          { id: "chaos-test/restate-0", selectorKey: ".", injectedCount: 1 },
        ],
      },
    },
  };
  assert.equal(injected(experiment, "chaos-test"), true);
  assert.equal(injected(experiment, "another-namespace"), false);
  assert.equal(injected({ ...experiment, status: {} }, "chaos-test"), false);
  const records = experiment.status!.experiment!.containerRecords!;
  records.push({
    id: "chaos-test/restate-1",
    selectorKey: ".Target",
    injectedCount: 0,
  });
  assert.equal(injected(experiment, "chaos-test"), false);
  records[1].injectedCount = 1;
  assert.equal(injected(experiment, "chaos-test"), true);
  assert.deepEqual(victims(experiment), ["chaos-test/restate-0"]);
});

test("failed Jobs cannot be mistaken for successful or still-running Jobs", () => {
  assert.equal(jobOutcome({}), "RUNNING");
  assert.equal(jobOutcome({ status: { succeeded: 1 } }), "PASS");
  assert.equal(jobOutcome({ status: { failed: 1 } }), "FAIL");
  assert.equal(
    jobOutcome({
      status: { conditions: [{ type: "FailureTarget", status: "True" }] },
    }),
    "FAIL",
  );
  assert.equal(
    jobOutcome({
      status: { conditions: [{ type: "Complete", status: "False" }] },
    }),
    "RUNNING",
  );
});

test("manifest rendering preserves seeds and bounds the driver", async () => {
  const conf = { seed: "quote'\"\n${UNKNOWN}", bootstrap: false };
  const values = {
    NS: "chaos-test",
    RESTATE_CONTAINER_IMAGE: "example/restate:main",
    SERVICES_CONTAINER_IMAGE: "example/services:main",
    DRIVER_IMAGE: "example/driver:main",
    JOB_DEADLINE_SECONDS: "1500",
    STUCK_DETECTOR_SECONDS: "450",
    DRIVER_CONF: JSON.stringify(JSON.stringify(conf)),
  };
  const manifests = resolve(suite, "manifests");
  for (const name of await readdir(manifests)) {
    for (const doc of parseAllDocuments(
      render(await readFile(resolve(manifests, name), "utf8"), values),
    )) {
      assert.deepEqual(doc.errors, []);
      const resource = doc.toJS();
      if (resource.kind !== "Job") continue;
      const env = resource.spec.template.spec.containers[0].env;
      const value = (key: string) =>
        env.find((e: { name: string }) => e.name === key).value;
      assert.deepEqual(JSON.parse(value("INTERPRETER_DRIVER_CONF")), conf);
      assert.equal(resource.spec.backoffLimit, 0);
      assert.equal(resource.spec.activeDeadlineSeconds, 1500);
      // The stuck detector must fire well before the Job deadline so its
      // invocation-level diagnostics end up in the artifact.
      assert.equal(value("STUCK_DETECTOR_TIMEOUT_SECONDS"), "450");
    }
  }
  assert.throws(() => render("${MISSING}", {}), /Unknown manifest placeholder/);
  assert.throws(() => settings({ CHAOS_SECONDS: "0" }), /positive integer/);
  assert.throws(() => settings({ SCENARIOS: "nope" }), /SCENARIOS must select/);
  assert.deepEqual(settings({ SCENARIOS: "pod-kill-one" }).scenarios, [
    "pod-kill-one",
  ]);
});

test("every scenario is a repeating Schedule scoped to this namespace's Restate pods", async () => {
  const scenarios = resolve(suite, "scenarios");
  for (const name of await readdir(scenarios)) {
    const docs = parseAllDocuments(
      render(await readFile(resolve(scenarios, name), "utf8"), {
        NS: "chaos-test",
      }),
    );
    assert.equal(docs.length, 1, name);
    const schedule = docs[0].toJS();
    assert.equal(schedule.kind, "Schedule", name);
    assert.equal(schedule.metadata.name, "experiment", name);
    assert.equal(schedule.metadata.namespace, "chaos-test", name);
    assert.match(schedule.spec.schedule, /^@every [1-9]\d*s$/, name);
    assert.equal(schedule.spec.concurrencyPolicy, "Forbid", name);
    const fault = schedule.spec.podChaos ?? schedule.spec.networkChaos;
    for (const selector of [fault.selector, fault.target?.selector]) {
      if (!selector) continue;
      assert.deepEqual(selector.namespaces, ["chaos-test"], name);
      assert.equal(
        selector.labelSelectors["app.kubernetes.io/name"],
        "restate",
        name,
      );
    }
  }
});
