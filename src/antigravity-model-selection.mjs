export const ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const ANTIGRAVITY_ORCHESTRATOR_PREFIX = "orchestrator:";

const EFFORT_SUFFIX = new RegExp(`^(.+)-(${ANTIGRAVITY_EFFORTS.join("|")})$`, "i");

function routeUnavailable(message) {
  const error = new Error(message);
  error.code = "ANTIGRAVITY_MODEL_ROUTE_UNAVAILABLE";
  return error;
}

function catalogUnavailable(message) {
  const error = new Error(message);
  error.code = "ANTIGRAVITY_MODEL_CATALOG_UNAVAILABLE";
  return error;
}

function assertEffortLevel(effort, effortLevels) {
  if (Array.isArray(effortLevels) && effortLevels.length && !effortLevels.includes(effort)) {
    throw new Error(`Installed Antigravity does not accept the ${effort} effort (supported: ${effortLevels.join(", ")}).`);
  }
}

function labelLookup(advertisedLabels) {
  const labels = new Map();
  for (const [id, label] of Object.entries(advertisedLabels || {})) {
    if (typeof label === "string" && label.trim()) labels.set(String(id).trim().toLowerCase(), label.trim());
  }
  return labels;
}

// Orchestrator route syntax: "orchestrator:<planner-route>+<executor-route>", for example
// "orchestrator:gemini-4-neon-xhigh+gemini-4-hydrogen-xhigh". Both routes are advertised
// model IDs. agy (1.5.14+) selects the orchestrator with --model and reads the planner and
// executor (model and effort, as display labels) from the "orchestrator" settings key, which
// --settings can supply for one session without touching the user's settings.json.
function resolveOrchestratorSelection({ requested, advertisedModels, advertisedLabels, settingsSupported, effortLevels }) {
  const spec = requested.slice(ANTIGRAVITY_ORCHESTRATOR_PREFIX.length);
  const parts = spec.split("+").map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(`Antigravity orchestrator route must be ${ANTIGRAVITY_ORCHESTRATOR_PREFIX}<planner-route>+<executor-route>, got ${requested}.`);
  }
  if (!settingsSupported) {
    throw new Error("Installed Antigravity cannot pass session --settings, so it cannot select orchestrator planner and executor models.");
  }
  if (!Array.isArray(advertisedModels)) {
    throw catalogUnavailable(`Antigravity model catalog could not be read, so route ${requested} cannot be translated safely.`);
  }
  const labels = labelLookup(advertisedLabels);
  if (!labels.size) {
    throw catalogUnavailable(`Antigravity model labels could not be read, so route ${requested} cannot be translated safely.`);
  }
  const available = new Set(advertisedModels.map((entry) => String(entry).trim().toLowerCase()));
  const roles = {};
  for (const [role, route] of [["planner", parts[0]], ["executor", parts[1]]]) {
    const key = route.toLowerCase();
    if (!available.has(key) || !labels.has(key)) {
      throw routeUnavailable(`Antigravity orchestrator ${role} route ${route} is not advertised by the installed CLI.`);
    }
    const effort = route.match(EFFORT_SUFFIX)?.[2]?.toLowerCase() || null;
    if (effort) assertEffortLevel(effort, effortLevels);
    roles[role] = { route, label: labels.get(key), effort };
  }
  const family = roles.planner.label.replace(/\s*\([^)]*\)\s*$/, "").trim().split(/\s+/).at(-1);
  const orchestratorLabel = `Orchestrator (${family})`.toLowerCase();
  const orchestrator = [...labels.entries()].find(([id, label]) => available.has(id) && label.toLowerCase() === orchestratorLabel);
  if (!orchestrator) {
    throw routeUnavailable(`Antigravity does not advertise an orchestrator for planner ${roles.planner.route} (expected label Orchestrator (${family})).`);
  }
  const model = advertisedModels.find((entry) => String(entry).trim().toLowerCase() === orchestrator[0]);
  return {
    model,
    effort: null,
    effortSource: "orchestrator_settings",
    settings: { orchestrator: { planner: roles.planner.label, executor: roles.executor.label } },
    orchestrator: { label: orchestrator[1], planner: roles.planner, executor: roles.executor },
  };
}

export function resolveAntigravityModelSelection({
  model,
  advertisedModels,
  advertisedLabels = null,
  effortSupported = false,
  effortLevels = null,
  settingsSupported = false,
  requireAdvertisedRoute = false,
} = {}) {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) return { model: null, effort: null, effortSource: null };
  if (requested.toLowerCase().startsWith(ANTIGRAVITY_ORCHESTRATOR_PREFIX)) {
    return resolveOrchestratorSelection({ requested, advertisedModels, advertisedLabels, settingsSupported, effortLevels });
  }

  const catalogAvailable = Array.isArray(advertisedModels);
  const available = new Set((advertisedModels || []).map((entry) => String(entry).trim().toLowerCase()));
  const suffixed = requested.match(EFFORT_SUFFIX);
  let selection = { model: requested, effort: null, effortSource: null };
  if (!catalogAvailable && suffixed && !effortSupported) {
    throw new Error(`Installed Antigravity cannot select the explicit ${suffixed[2].toLowerCase()} model effort.`);
  }
  if (!catalogAvailable && effortSupported) {
    throw catalogUnavailable(`Antigravity model catalog could not be read, so route ${requested} cannot be translated safely.`);
  }
  if (suffixed && available.has(requested.toLowerCase())) {
    selection = {
      model: suffixed[1],
      effort: suffixed[2].toLowerCase(),
      effortSource: "explicit_route",
    };
  } else if (suffixed && requireAdvertisedRoute) {
    throw routeUnavailable(`Antigravity model route ${requested} is not advertised by the installed CLI.`);
  } else {
    for (const effort of ["high", "medium", "low"]) {
      if (!available.has(`${requested}-${effort}`.toLowerCase())) continue;
      selection = { model: requested, effort, effortSource: "inferred_from_advertised_route" };
      break;
    }
  }

  if (!selection.effort || effortSupported) {
    if (selection.effortSource === "explicit_route" && effortSupported) assertEffortLevel(selection.effort, effortLevels);
    return selection;
  }
  if (selection.effortSource === "explicit_route") {
    throw new Error(`Installed Antigravity cannot select the explicit ${selection.effort} model effort.`);
  }
  return { ...selection, effort: null, effortSource: "inferred_but_unsupported" };
}
