import assert from "node:assert/strict";
import test from "node:test";
import {
  GuidedWebsiteWorkflow,
  pageControls,
  pageView,
} from "./guided-website-workflow.mjs";

const page = (name) => ({
  url: `https://site.example/${name}`,
  documentId: `doc-${name}`,
  inputRevision: 1,
  title: name,
  text: `Page ${name}`,
  elements: [],
});

test("the planner sees the step shown on the previous page", async () => {
  const owner = { actorId: "owner" };
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    observation: { id: "observed" },
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  let current = page("A");
  const actuator = {
    readObservation: () => ({
      observation: task.observation,
      snapshot: current,
    }),
    quiesce: async () => {},
  };
  const seen = [];
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator,
    taskId: task.id,
    planStep: async ({ page: view, history }) => {
      seen.push({ page: view.title, history });
      return {
        status: "wait",
        step: `Press Next on ${view.title}`,
        message: "",
      };
    },
  });
  for (const name of ["A", "A", "B", "C"]) {
    current = page(name);
    assert.equal((await workflow.refresh()).kind, "wait");
  }
  assert.deepEqual(seen, [
    { page: "A", history: [] },
    { page: "A", history: [] },
    { page: "B", history: ["Press Next on A"] },
    { page: "C", history: ["Press Next on A", "Press Next on B"] },
  ]);
});

test("the planner sees page blockers by control ref, never a selector", () => {
  const snapshot = {
    ...page("A"),
    elements: [
      { tag: "button", label: "Reject all", selector: "snap:0:0" },
      { tag: "button", label: "Close", selector: "snap:0:1" },
      {
        tag: "input",
        type: "password",
        label: "Password",
        sensitive: "password",
        selector: "snap:0:2",
      },
    ],
    blockers: [
      {
        kind: "cookie-consent",
        covers: "target",
        rejectRef: "snap:0:0",
        ref: "snap:0:1",
        text: "We use cookies",
      },
      { kind: "modal", covers: "viewport", ref: "snap:0:1" },
      { kind: "login-wall", covers: "viewport", ref: "snap:0:2" },
      { kind: "captcha", covers: "partial", ref: "snap:0:1" },
    ],
  };
  const index = pageControls(snapshot);
  const view = pageView(snapshot, index);
  const refOf = (label) =>
    index.controls.find(({ element }) => element.label === label).ref;
  assert.deepEqual(view.blockers, [
    // A consent banner offers only its reject control.
    {
      kind: "cookie-consent",
      rejectRef: refOf("Reject all"),
      covers: "target",
      text: "We use cookies",
    },
    { kind: "modal", ref: refOf("Close"), covers: "viewport" },
    // A protected field is never offered as a blocker control.
    { kind: "login-wall", covers: "viewport" },
    // Only the person answers a person check.
    { kind: "captcha", covers: "partial" },
  ]);
  assert.equal(JSON.stringify(view).includes("snap:0:"), false);
  assert.deepEqual(pageView(page("B"), pageControls(page("B"))).blockers, []);
});
