import { join } from "node:path";
import { defaultWorkspace, expandDir } from "../paths.ts";
import type { Store } from "../store/store.ts";
import { validateWorkflow } from "./load.ts";

/**
 * First-run sample workflow (task 15.127).
 *
 * Self-contained on purpose: `mcp: []` and `tools: "none"`, so it succeeds on a fresh install with
 * any agent CLI and zero MCP setup, while showcasing chief's core features in one short run:
 * declared `input-fields` + Form | JSON view, a multi-step DAG, an interactive `ask` human gate,
 * and formatted Markdown output in the run record.
 */
export const STARTER_WORKFLOW_NAME = "trip-planner";

export const STARTER_WORKFLOW = {
  name: STARTER_WORKFLOW_NAME,
  description: "Sample workflow to explore chief — run it, inspect it in the Designer, or delete it anytime.",
  inputs: {
    days: 3,
    vibe: "food-and-culture",
  },
  "input-fields": [
    {
      path: "destination",
      label: "Destination",
      type: "text",
      required: true,
      description: "City or region you want to visit (for example Kyoto, Japan).",
    },
    {
      path: "days",
      label: "Number of days",
      type: "number",
      required: false,
      description: "How many days to plan for.",
    },
    {
      path: "vibe",
      label: "Trip vibe",
      type: "choose-one",
      required: false,
      description: "The overall style of the itinerary.",
      options: [
        { label: "Food & culture", value: "food-and-culture" },
        { label: "Outdoors & nature", value: "outdoors-and-nature" },
        { label: "Relaxed & slow", value: "relaxed-and-slow" },
      ],
    },
  ],
  nodes: [
    {
      id: "brainstorm",
      label: "Brainstorm highlights",
      type: "agent",
      position: { x: 260, y: 40 },
      mcp: [],
      tools: "none",
      prompt: [
        "Propose 5 memorable highlights for a {{inputs.days}}-day trip to {{inputs.destination}} with a {{inputs.vibe}} vibe.",
        "For each highlight, include a short title, neighborhood or area, why it stands out, and best time of day.",
        "Return JSON with a `highlights` list.",
      ].join("\n"),
      "output-schema": {
        highlights: [{ title: "string", area: "string", why: "string", best_time: "string" }],
      },
    },
    {
      id: "choose",
      label: "Pick your favourites",
      type: "gate",
      kind: "ask",
      position: { x: 260, y: 190 },
      prompt: [
        "Ask the user which of the proposed highlights from the previous step they want to include in their itinerary,",
        "plus an optional free-text question for any must-visit spots, pace preference, or dietary notes.",
      ].join(" "),
    },
    {
      id: "itinerary",
      label: "Write day-by-day plan",
      type: "agent",
      position: { x: 260, y: 340 },
      mcp: [],
      tools: "none",
      context: "all",
      prompt: [
        "Write a crisp, practical {{inputs.days}}-day itinerary for {{inputs.destination}} ({{inputs.vibe}} vibe)",
        "centred on the highlights and preferences the user picked in the previous gate.",
        "Format the itinerary in clear Markdown grouped by day (Morning / Afternoon / Evening) and return it under `itinerary_markdown` along with a one-line `summary`.",
      ].join("\n"),
      "output-schema": { summary: "string", itinerary_markdown: "string" },
    },
  ],
  edges: [
    { from: "brainstorm", to: "choose" },
    { from: "choose", to: "itinerary" },
  ],
} as const;

export const STARTER_INPUT_SET = {
  name: "Kyoto · 3 days (sample)",
  values: {
    destination: "Kyoto, Japan",
    days: 3,
    vibe: "food-and-culture",
  },
} as const;

/**
 * Seed the sample workflow and its ready-to-run input data set once on a fresh install.
 *
 * Skips when `CHIEF_NO_SEED=1`, when already seeded once (`starter-seeded`), or when the database
 * already holds any workflow — so existing users are never cluttered and a user who deletes the
 * sample never sees it reappear on restart.
 */
export function seedStarterWorkflow(store: Store): boolean {
  if (process.env.CHIEF_NO_SEED === "1") return false;
  if (store.getSetting<boolean>("starter-seeded", false)) return false;
  store.setSetting("starter-seeded", true);
  if (store.listWorkflows().length > 0) return false;

  const { workflow, errors } = validateWorkflow(STARTER_WORKFLOW);
  if (!workflow || errors.length > 0) {
    throw new Error(`Invalid starter workflow: ${errors.join("; ")}`);
  }
  const wsSetting = store.getSetting<string | null>("workspace-dir", null);
  const ws = wsSetting ? expandDir(wsSetting, process.cwd()) : defaultWorkspace();
  const row = store.saveWorkflow(workflow.name, workflow, join(ws, workflow.name), "version");
  store.addInputSet(row.id, STARTER_INPUT_SET.name, STARTER_INPUT_SET.values);
  return true;
}
