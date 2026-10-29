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
      // Unknown kinds or coverage from a browser are not shown at all.
      { kind: "Captcha", covers: "partial", ref: "snap:0:1" },
      { kind: "modal", covers: "most", ref: "snap:0:1" },
      null,
      { kind: "paywall", covers: "partial", text: "y".repeat(500) },
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
    { kind: "paywall", covers: "partial", text: "y".repeat(200) },
  ]);
  assert.equal(JSON.stringify(view).includes("snap:0:"), false);
  assert.deepEqual(pageView(page("B"), pageControls(page("B"))).blockers, []);
});

test("a host words the outcome of a planned browser action", async () => {
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    authorization: { decisionId: "grant" },
    observation: { id: "observed", version: 1, inputRevision: 1 },
  };
  const snapshot = {
    ...page("A"),
    elements: [
      {
        tag: "button",
        label: "Next",
        selector: "snap:0:0",
        targetSelector: "#next",
      },
    ],
  };
  const results = [
    { status: "failed", evidenceRef: "not-dispatched" },
    { status: "failed", evidenceRef: "evidence:after" },
    { status: "unknown" },
  ];
  const runtime = {
    owner: { actorId: "owner" },
    get: () => task,
    observe: async () => task,
    control: () => {},
    execute: async (_id, _revision, proposal) => ({
      operations: [{ proposal, ...results.shift() }],
    }),
  };
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator: {
      readObservation: () => ({ observation: task.observation, snapshot }),
      quiesce: async () => {},
    },
    taskId: task.id,
    planStep: async ({ page: view }) => ({
      status: "act",
      kind: "agent-action",
      action: "click",
      ref: view.controls[0].ref,
      step: "Press Next",
      message: "",
    }),
    authorizeAction: () => true,
    words: {
      actionNotSent: "not sent",
      actionUnexpected: "unexpected",
      actionUnverified: "unverified",
    },
  });
  const outcome = async () => {
    const offer = await workflow.refresh();
    assert.equal(offer.kind, "agent-action");
    return workflow.executeAction(offer.offerKey);
  };
  assert.deepEqual(await outcome(), {
    kind: "blocked",
    reason: "not sent",
    reasonCode: "action-not-sent",
  });
  assert.deepEqual(await outcome(), {
    kind: "blocked",
    reason: "unexpected",
    reasonCode: "action-failed",
  });
  assert.deepEqual(await outcome(), {
    kind: "unknown-outcome",
    reasonCode: "action-unverified",
    message: "unverified",
  });
});

test("a lost record of her own pointed submit is asked about only off its page", async () => {
  const task = {
    id: "task-1",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    observation: { id: "observed" },
  };
  const runtime = {
    owner: { actorId: "owner" },
    get: () => task,
    observe: async () => {},
  };
  const activity = (captureGap, extra = {}) => ({
    events: [],
    overflow: false,
    captureGap,
    ...extra,
  });
  const at = (name, documentId, manualActivity, elements = []) => ({
    ...page(name),
    documentId,
    manualActivity,
    elements,
  });
  const search = { tag: "button", label: "Search", selector: "snap:0:0" };
  const link = {
    tag: "a",
    label: "Invoices",
    href: "https://site.example/invoices#top",
    selector: "snap:0:0",
  };
  let current;
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator: {
      readObservation: () => ({
        observation: task.observation,
        snapshot: current,
      }),
      quiesce: async () => {},
    },
    taskId: task.id,
    planStep: async ({ page: view }) =>
      view.controls.length
        ? {
            status: "act",
            ref: view.controls[0].ref,
            step: "Press it",
            message: "",
          }
        : { status: "wait", step: "Wait", message: "" },
  });
  const show = async (snapshot) => {
    current = snapshot;
    return workflow.refresh();
  };
  // She presses the Search button she was shown; the page it opens lost the
  // record of that submit. That is her step, not something to check.
  assert.equal(
    (await show(at("search", "doc-1", activity(false), [search]))).kind,
    "human-review",
  );
  assert.equal(
    (await show(at("results", "doc-1", activity(true), [link]))).kind,
    "human-review",
  );
  // The same document's gap is explained; her next pointed link lands on the
  // address it names, without a question.
  assert.equal(
    (await show(at("invoices", "doc-1", activity(true), [search]))).kind,
    "human-review",
  );
  // Overflow, and a form sent before this epoch, are still asked about there.
  assert.equal(
    (
      await show(
        at("next", "doc-2", activity(false, { overflow: true }), [search]),
      )
    ).reason,
    "manual-activity",
  );
  task.epoch = 2;
  const earlier = {
    kind: "form-submit",
    origin: "https://site.example",
    documentId: "doc-2",
    epoch: 1,
    observedAt: 1,
  };
  assert.equal(
    (await show(at("next", "doc-2", activity(false, { events: [earlier] }))))
      .reason,
    "manual-activity",
  );
  // A pointed link that lands elsewhere: the gap is asked about.
  workflow.acknowledge(
    (await show(at("next", "doc-2", activity(false, { events: [earlier] }))))
      .key,
  );
  assert.equal(
    (await show(at("list", "doc-3", activity(false), [link]))).kind,
    "human-review",
  );
  const elsewhere = await show(at("other", "doc-3", activity(true)));
  assert.equal(elsewhere.reason, "manual-activity");
  // Her answer covers that gap at that address in that epoch, never a later
  // gap on another page or in another epoch.
  workflow.acknowledge(elsewhere.key);
  // A choice she ticks opens no page.
  const choice = {
    tag: "input",
    type: "checkbox",
    label: "Paperless",
    selector: "snap:0:0",
  };
  assert.equal(
    (await show(at("other", "doc-3", activity(true), [choice]))).kind,
    "human-review",
  );
  const later = await show(at("another", "doc-4", activity(true)));
  assert.equal(later.reason, "manual-activity");
  assert.notEqual(later.key, elsewhere.key);
  task.epoch = 3;
  const nextEpoch = await show(at("other", "doc-5", activity(true)));
  assert.equal(nextEpoch.reason, "manual-activity");
  assert.notEqual(nextEpoch.key, elsewhere.key);
});
