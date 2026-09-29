// Synthetic cases based on observed interaction shapes, never captured payloads.
// Labels assess the next parent generation, not end-to-end task success.
import { Context } from "../src/context.mjs";

export const phaseCases = [
  {
    id: "delegated-release-wait",
    accepted: ["low"],
    prompt: "Deploy the receipt deletion feature to the phone.",
    notes: [
      "The release worker owns review, fixes, tests and deployment. I will wait for its report, then independently verify.",
      "Review caught a timing edge: a finishing scan could overwrite its cancelled job state after deletion. The worker is fixing and testing it before deployment.",
      "The timing fix is still in progress. Deployment is waiting for its regression check.",
    ],
    tool: "wait_agent",
    output: { message: "Wait timed out.", timed_out: true },
  },
  {
    id: "delegated-release-needs-decision",
    accepted: ["high", "xhigh"],
    prompt: "Deploy the receipt deletion feature to the phone.",
    notes: ["The release worker was reviewing scan/deletion concurrency."],
    tool: "wait_agent",
    output:
      "Worker blocked: deleting before the scan commits can resurrect a receipt; deleting afterward can orphan files. I need you to choose the transaction and cancellation design before I continue. Neither approach is validated.",
  },
  {
    id: "build-poll-with-unfinished-release",
    accepted: ["low"],
    prompt: "Release the compact receipt layout to the phone.",
    notes: [
      "The signed build is running for the paired phone. It contains only the compact layout on top of the installed release. Installation and API verification remain after compilation.",
    ],
    tool: "write_stdin",
    output: "Build process running. Compiling application. No new errors.",
  },
  {
    id: "scope-confirmation-after-design",
    accepted: ["low"],
    original:
      "Design configurable weighted feedback thresholds, subject attribution, tenant scope, and notifications.",
    prompt:
      "Use a dropdown: company counts all its locations and engagements; location counts its engagements; engagement counts only its own surveys.",
    notes: [
      "Subject relationships are verified. The only pending question is which scope should aggregate the score. I will confirm the chosen behavior before implementation.",
    ],
    tool: "read",
    output:
      "Earlier model inspection: Subject belongs to company, location or engagement. Mentions can have multiple subjects. Scoring and notification policy remain future work.",
  },
  {
    id: "preview-clarification-after-design",
    accepted: ["low"],
    original:
      "Design configurable weighted feedback thresholds, subject attribution, tenant scope, and notifications.",
    prompt:
      "Correct, let's do a first try on admin. I'll see it and give feedback.",
    notes: [
      "Subject, scope, sentiment, threshold and duration are agreed. Before implementing, clarify whether the first version is configuration only or sends notifications.",
    ],
    tool: "read",
    output: "Existing scope relationships verified. No implementation started.",
  },
  {
    id: "crud-implementation-control",
    accepted: ["medium", "high"],
    prompt: "Implement the feedback trend CRUD, without notification delivery.",
    notes: [
      "Follow the existing forms and scope permissions. Need implement persistence, validation and company/location/engagement access without cross-tenant leaks.",
    ],
    tool: "read",
    output:
      "Existing CRUD pattern found. Location managers may configure their location; engagement-only grants are read-only. Relationships and authorization helpers are available.",
  },
];

export function phaseState(c) {
  const context = new Context();
  context.reset(c.original ?? c.prompt);
  for (const text of c.notes)
    context.add({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text }],
    });
  context.addHook({
    tool_use_id: "phase-fixture",
    tool_name: c.tool,
    tool_input: {},
    tool_response: c.output,
  });
  if (c.original) context.nextTurn(c.prompt);
  return context.state({
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    previousEffort: "high",
    step: c.original ? 1 : 5,
    newToolFailures: 0,
  });
}
