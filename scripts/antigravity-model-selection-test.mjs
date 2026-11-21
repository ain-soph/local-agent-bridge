import assert from "node:assert/strict";
import { resolveAntigravityModelSelection } from "../src/antigravity-model-selection.mjs";

const advertisedModels = [
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gpt-oss-120b-medium",
];

assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-3.6-flash",
  advertisedModels,
  effortSupported: true,
}), {
  model: "gemini-3.6-flash",
  effort: "high",
  effortSource: "inferred_from_advertised_route",
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels,
  effortSupported: true,
}), {
  model: "gemini-3.6-flash",
  effort: "medium",
  effortSource: "explicit_route",
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "custom-model-high",
  advertisedModels,
  effortSupported: true,
}), {
  model: "custom-model-high",
  effort: null,
  effortSource: null,
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-3.6-flash",
  advertisedModels,
  effortSupported: false,
}), {
  model: "gemini-3.6-flash",
  effort: null,
  effortSource: "inferred_but_unsupported",
});
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels,
  effortSupported: false,
}), /cannot select the explicit medium model effort/i);
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels: null,
  effortSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_CATALOG_UNAVAILABLE");
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash",
  advertisedModels: null,
  effortSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_CATALOG_UNAVAILABLE");
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.6-flash-medium",
  advertisedModels: null,
  effortSupported: false,
}), /cannot select the explicit medium model effort/i);
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-3.5-flash-high",
  advertisedModels,
  effortSupported: true,
  requireAdvertisedRoute: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_ROUTE_UNAVAILABLE");
assert.deepEqual(resolveAntigravityModelSelection({
  model: "-high",
  advertisedModels: ["-high"],
  effortSupported: true,
}), {
  model: "-high",
  effort: null,
  effortSource: null,
});

// agy 1.5.14: xhigh/max routes and the Orchestrator planner/executor settings.
const modernModels = [
  "gemini-4-neon-high", "gemini-4-neon-xhigh", "gemini-4-neon-medium",
  "gemini-4-argon-high",
  "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh",
  "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator-g1-pro",
];
const modernLabels = {
  "gemini-4-neon-high": "Gemini 4 Neon (High)",
  "gemini-4-neon-xhigh": "Gemini 4 Neon (XHigh)",
  "gemini-4-neon-medium": "Gemini 4 Neon (Medium)",
  "gemini-4-argon-high": "Gemini 4 Argon (High)",
  "gemini-4-hydrogen-high": "Gemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-xhigh": "Gemini 4 Hydrogen (XHigh)",
  "gemini-pro-orchestrator-neon": "Orchestrator (Neon)",
  "gemini-pro-orchestrator-g1-pro": "Orchestrator (Argon)",
};
const effortLevels = ["low", "medium", "high", "xhigh", "max"];
assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-4-neon-xhigh",
  advertisedModels: modernModels,
  effortSupported: true,
  effortLevels,
}), {
  model: "gemini-4-neon",
  effort: "xhigh",
  effortSource: "explicit_route",
});
assert.throws(() => resolveAntigravityModelSelection({
  model: "gemini-4-neon-xhigh",
  advertisedModels: modernModels,
  effortSupported: true,
  effortLevels: ["low", "medium", "high"],
}), /does not accept the xhigh effort/i);
assert.deepEqual(resolveAntigravityModelSelection({
  model: "gemini-4-neon",
  advertisedModels: modernModels,
  effortSupported: true,
}), {
  model: "gemini-4-neon",
  effort: "high",
  effortSource: "inferred_from_advertised_route",
});
assert.deepEqual(resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-neon-xhigh+gemini-4-hydrogen-xhigh",
  advertisedModels: modernModels,
  advertisedLabels: modernLabels,
  effortSupported: true,
  effortLevels,
  settingsSupported: true,
}), {
  model: "gemini-pro-orchestrator-neon",
  effort: null,
  effortSource: "orchestrator_settings",
  settings: { orchestrator: { planner: "Gemini 4 Neon (XHigh)", executor: "Gemini 4 Hydrogen (XHigh)" } },
  orchestrator: {
    label: "Orchestrator (Neon)",
    planner: { route: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)", effort: "xhigh" },
    executor: { route: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)", effort: "xhigh" },
  },
});
assert.equal(resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-argon-high+gemini-4-hydrogen-high",
  advertisedModels: modernModels,
  advertisedLabels: modernLabels,
  effortSupported: true,
  settingsSupported: true,
}).model, "gemini-pro-orchestrator-g1-pro");
assert.throws(() => resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-neon-max+gemini-4-hydrogen-xhigh",
  advertisedModels: modernModels,
  advertisedLabels: modernLabels,
  effortSupported: true,
  settingsSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_ROUTE_UNAVAILABLE");
assert.throws(() => resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-hydrogen-high+gemini-4-neon-high",
  advertisedModels: modernModels,
  advertisedLabels: modernLabels,
  effortSupported: true,
  settingsSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_ROUTE_UNAVAILABLE" && /Orchestrator \(Hydrogen\)/.test(error.message));
assert.throws(() => resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-neon-xhigh+gemini-4-hydrogen-xhigh",
  advertisedModels: modernModels,
  advertisedLabels: modernLabels,
  effortSupported: true,
  settingsSupported: false,
}), /cannot pass session --settings/i);
assert.throws(() => resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-neon-xhigh+gemini-4-hydrogen-xhigh",
  advertisedModels: modernModels,
  advertisedLabels: null,
  effortSupported: true,
  settingsSupported: true,
}), (error) => error.code === "ANTIGRAVITY_MODEL_CATALOG_UNAVAILABLE");
assert.throws(() => resolveAntigravityModelSelection({
  model: "orchestrator:gemini-4-neon-xhigh",
  advertisedModels: modernModels,
  advertisedLabels: modernLabels,
  effortSupported: true,
  settingsSupported: true,
}), /planner-route>\+<executor-route/);

console.log("Antigravity model selection tests passed for advertised routes, inferred effort, catalog failures, unavailable fallbacks, legacy CLIs, unrelated model names, xhigh routes, and orchestrator planner/executor settings.");
