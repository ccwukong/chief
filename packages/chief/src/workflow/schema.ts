import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lower-case kebab-case");

const sandbox = z
  .object({
    network: z.boolean().default(false),
    write: z.array(z.string()).default([]),
    env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  })
  .strict();

const duration = z.union([z.number().positive(), z.string().regex(/^\d+(ms|s|m|h)$/)]);

const compensate = z
  .object({
    prompt: z.string().optional(),
    run: z.string().optional(),
    interpreter: z.string().optional(),
    mcp: z.array(z.string()).optional(),
    model: z.string().optional(),
    sandbox: sandbox.optional(),
    timeout: duration.optional(),
  })
  .strict()
  .refine((c) => !!c.prompt !== !!c.run, "compensate needs exactly one of `prompt` or `run`");

const common = {
  id,
  label: z.string().optional(),
  cwd: z.string().optional(),
  timeout: duration.optional(),
  /** The node performs writes that cannot be undone; chief asks before running it. */
  irreversible: z.boolean().optional(),
  /** Set to false to skip the confirmation gate of an irreversible node. */
  confirm: z.boolean().optional(),
  compensate: compensate.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
};

const agentFields = {
  type: z.literal("agent"),
  prompt: z.string().min(1),
  /**
   * Which MCP servers the node may use. Omitted: all the agent CLI is connected to (the agent
   * decides). A list: only those. An empty list: none.
   */
  mcp: z.array(z.string()).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  "output-schema": z.any().optional(),
  /**
   * What the step is told about earlier steps without the prompt asking for it: the results of
   * the steps directly before it (`previous`, the default), of every earlier step (`all`), or
   * nothing (`none`). A result the prompt already refers to is never added twice.
   */
  context: z.enum(["previous", "all", "none"]).optional(),
  /** Built-in tool set: none (default), read-only, default, or an explicit list. */
  tools: z.union([z.enum(["none", "read-only", "default"]), z.array(z.string())]).optional(),
  "allowed-tools": z.array(z.string()).optional(),
  "disallowed-tools": z.array(z.string()).optional(),
  "permission-mode": z.string().optional(),
};

const scriptFields = {
  type: z.literal("script"),
  run: z.string().min(1),
  interpreter: z.string().optional(),
  args: z.array(z.string()).optional(),
  input: z.any().optional(),
  sandbox: sandbox.optional(),
};

const agentNode = z.object({ ...common, ...agentFields }).strict();
const scriptNode = z.object({ ...common, ...scriptFields }).strict();

const gateNode = z
  .object({
    id,
    label: z.string().optional(),
    position: common.position,
    type: z.literal("gate"),
    kind: z.enum(["ask", "select", "approve", "input"]),
    /** Text shown to the user above the form. Not an instruction (use `prompt` on an `ask` gate for that). */
    message: z.string().optional(),
    /** ask: what the human should be asked, in plain words. An agent turns it into a form when the run reaches the gate. */
    prompt: z.string().optional(),
    /** ask: the model and agent CLI that work out the form. */
    model: z.string().optional(),
    agent: z.string().optional(),
    /** select: the list to choose from. */
    from: z.any().optional(),
    modes: z.array(z.enum(["all", "by-priority", "one-by-one"])).optional(),
    /** approve: the value being approved (may be edited before approval). */
    value: z.any().optional(),
    /** input: context shown above the text box. */
    summary: z.any().optional(),
    options: z.array(z.string()).optional(),
  })
  .strict();

const innerNode = z.discriminatedUnion("type", [
  agentNode.extend({ id: id.optional() }),
  scriptNode.extend({ id: id.optional() }),
]);

const mapNode = z
  .object({
    id,
    label: z.string().optional(),
    position: common.position,
    type: z.literal("map"),
    over: z.any(),
    mode: z.string().default("sequential"),
    "max-parallel": z.number().int().positive().default(3),
    "on-error": z.enum(["fail", "continue"]).default("fail"),
    node: innerNode,
  })
  .strict();

export const nodeSchema = z.discriminatedUnion("type", [agentNode, scriptNode, gateNode, mapNode]);

const edge = z.union([
  z.string().regex(/^\s*[a-z0-9-]+\s*->\s*[a-z0-9-]+\s*$/, 'edges look like "a -> b"'),
  z.object({ from: id, to: id }).strict(),
]);

export const workflowSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "workflow names are lower-case kebab-case"),
    description: z.string().optional(),
    agent: z.string().optional(),
    budget: z.object({ "warn-usd": z.number().positive().optional(), "max-usd": z.number().positive().optional() }).strict().optional(),
    inputs: z.record(z.any()).default({}),
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(edge).default([]),
  })
  .strict();

export type AgentNode = z.infer<typeof agentNode>;
export type ScriptNode = z.infer<typeof scriptNode>;
export type GateNode = z.infer<typeof gateNode>;
export type MapNode = z.infer<typeof mapNode>;
export type InnerNode = z.infer<typeof innerNode>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type Compensate = z.infer<typeof compensate>;
export type SandboxSpec = z.infer<typeof sandbox>;
export interface Workflow extends Omit<z.infer<typeof workflowSchema>, "edges"> {
  edges: { from: string; to: string }[];
}

export function parseDuration(d: string | number | undefined, fallbackMs: number): number {
  if (d == null) return fallbackMs;
  if (typeof d === "number") return d * 1000;
  const m = d.match(/^(\d+)(ms|s|m|h)$/)!;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

// ── output-schema shorthand ───────────────────────────────────────────────
// `{ summary: string, items: [{ title, kind }] }`: a type name, null/"any" for anything,
// an object of fields, or a one-element array describing the element.

const TYPE_NAMES = ["string", "number", "boolean", "object", "array", "any"];

export function checkShorthand(schema: unknown, path = "output-schema"): string[] {
  if (schema == null) return [];
  if (typeof schema === "string") return TYPE_NAMES.includes(schema) ? [] : [`${path}: unknown type "${schema}"`];
  if (Array.isArray(schema)) return schema.length <= 1 ? checkShorthand(schema[0], `${path}[]`) : [`${path}: an array schema has exactly one element`];
  if (typeof schema === "object") return Object.entries(schema).flatMap(([k, v]) => checkShorthand(v, `${path}.${k}`));
  return [`${path}: unsupported schema value`];
}

/** Validate a value against the shorthand. Returns a list of problems (empty when valid). */
export function validateShorthand(schema: unknown, value: unknown, path = "$"): string[] {
  if (schema == null || schema === "any") return [];
  if (typeof schema === "string") {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    return actual === schema ? [] : [`${path}: expected ${schema}, got ${actual}`];
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    return value.flatMap((v, i) => validateShorthand(schema[0], v, `${path}[${i}]`));
  }
  if (typeof schema === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    return Object.entries(schema as object).flatMap(([k, s]) =>
      k in (value as any) ? validateShorthand(s, (value as any)[k], `${path}.${k}`) : [`${path}.${k}: missing`],
    );
  }
  return [];
}

export function describeShorthand(schema: unknown): string {
  return schema == null ? "any JSON object" : JSON.stringify(schema);
}
