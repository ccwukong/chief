import { describeShorthand } from "../workflow/schema.ts";

/** Appended to every agent node prompt: how to hand results, side effects and questions back to chief. */
export function agentContract(outputSchema: unknown, usesMcp = false): string {
  return [
    "",
    "---",
    "Output contract (required by the orchestrator running you):",
    `1. Finish your reply with exactly one fenced \`\`\`json block containing a JSON object. Shape: ${describeShorthand(outputSchema)}`,
    "   That JSON block is your result. It is what gets saved and what the next steps of the workflow, and the person reviewing it, are given. So put everything they need inside it, in full: every item you found or produced with its details, and every link as a complete URL. Do not put the substance in prose and only a summary, ids or counts in the JSON.",
    "   You do not need to store your result anywhere (a file, a database): the orchestrator saves the JSON for the following steps.",
    '2. In that object include "side_effects": an array with one entry per write you performed (message sent, comment posted, document, ticket or file created or changed): {"kind": "...", "ref": "<id>", "url": "<link>", "how_to_undo": "<how>", "irreversible": true|false}. Use [] when you performed none.',
    '3. If your instructions say to ask or confirm before a write, do NOT perform it. Instead finish with {"status": "needs_input", "question": "<what you need to know>", "proposed": <what you intend to do or send>, "side_effects": [...]}. You will be resumed with the answer.',
    ...(usesMcp ? ['4. This applies only to the MCP servers you were told you may use. If one of them is not connected, needs authentication, or its tools cannot be loaded or keep failing, do not work around it and do not guess. Finish with {"status": "mcp_unavailable", "server": "<server name>", "error": "<the exact error you got>", "side_effects": [...]}. A server you were not given is not an error: simply do not use it.'] : []),
  ].join("\n");
}

export function compensationContract(): string {
  return [
    "",
    "---",
    "You are undoing earlier work. Output contract:",
    'Finish your reply with exactly one fenced ```json block: {"reverted": ["<ref>", ...], "failed": [{"ref": "<ref>", "reason": "<why it could not be undone>"}]}.',
  ].join("\n");
}

export const REPAIR_PROMPT = (problem: string) =>
  `Your last reply did not satisfy the output contract: ${problem}\nReply again with only the final fenced \`\`\`json block. Do not repeat any action you already performed.`;

export const RESUME_PROMPT = "You were interrupted before finishing. Continue the task from where you stopped. Do not repeat writes you already performed. Finish with the required fenced ```json block.";

export function answerPrompt(answer: { decision?: string; value?: unknown; text?: string }): string {
  if (answer.decision === "reject") {
    return `The user declined${answer.text ? `: ${answer.text}` : "."}\nDo not perform the proposed action. Finish with the required fenced \`\`\`json block describing what was and was not done.`;
  }
  const parts = ["The user approved."];
  if (answer.text) parts.push(`Their reply: ${answer.text}`);
  if (answer.value !== undefined) parts.push(`Use this edited version instead of your proposal:\n${typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value, null, 2)}`);
  parts.push("Proceed now, then finish with the required fenced ```json block.");
  return parts.join("\n");
}

/** Pull the final JSON value out of an agent reply: last fenced block, else the last parseable object. */
/**
 * What an agent wrote besides its JSON result: the reply with the final fenced JSON block taken
 * out. Kept so that content a step put in prose is not lost to the steps after it.
 */
export function proseOf(text: string): string {
  const fences = [...text.matchAll(/```(?:json)?\s*\n[\s\S]*?```/g)];
  const last = fences.at(-1);
  return (last ? text.slice(0, last.index) + text.slice(last.index! + last[0].length) : text).trim();
}

export function extractJson(text: string): { ok: true; value: any } | { ok: false; problem: string } {
  const tryParse = (s: string) => { try { return { ok: true as const, value: JSON.parse(s) }; } catch { return null; } };
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (const f of fences.reverse()) { const r = tryParse(f); if (r) return r; }
  const whole = tryParse(text.trim());
  if (whole) return whole;
  const end = text.lastIndexOf("}");
  if (end >= 0) {
    let tries = 0;
    for (let i = text.lastIndexOf("{", end); i >= 0 && tries < 300; i = text.lastIndexOf("{", i - 1), tries++) {
      const r = tryParse(text.slice(i, end + 1));
      if (r) return r;
      if (i === 0) break;
    }
  }
  return { ok: false, problem: "no JSON block found in the reply" };
}
