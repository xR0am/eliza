/**
 * JSON helpers for parsing and validating model-produced tool/resource
 * selections: parseJSON strips code fences and surrounding prose then parses with
 * JSON5 leniency, and validateJsonSchema gates a value against a JSON Schema via
 * Ajv. Used on the untrusted-model-output boundary in the selection flow.
 *
 * MCP tool `inputSchema` is attacker-controlled. A byte, depth, and node budget
 * limits compile work and the tool-compatibility rewrite; each schema then uses
 * an isolated Ajv so untrusted `$id` values cannot poison process-wide state.
 * Compile and evaluation failures are translated to an invalid-schema result
 * at this boundary.
 */
import Ajv from "ajv";
import JSON5 from "json5";
import { getMcpJsonSchemaBudgetError } from "./schema-budget.js";

export {
  assertMcpJsonSchemaBudget,
  getMcpJsonSchemaBudgetError,
  MAX_MCP_SCHEMA_DEPTH,
  MAX_MCP_SCHEMA_JSON_BYTES,
  MAX_MCP_SCHEMA_NODES,
  MCP_TOOL_SCHEMA_UNBOUNDED,
} from "./schema-budget.js";

/** Balanced `{...}` regions in `text`, in the order their `{` appears. Braces
 * written in prose, in a JSON5 string, or in a JSON5 comment do not change the
 * depth, so they never end a region early. */
function* balancedObjects(text: string): Generator<string> {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quote: string | undefined;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "/" && text[index + 1] === "/") {
        const newline = text.indexOf("\n", index);
        if (newline === -1) break;
        index = newline;
      } else if (character === "/" && text[index + 1] === "*") {
        const end = text.indexOf("*/", index + 2);
        if (end === -1) break;
        index = end + 1;
      } else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, index + 1);
          break;
        }
      }
    }
  }
}

/** Model text is untrusted and small; a brace-per-byte reply must not make the
 * candidate scan quadratic. */
const MAX_OBJECT_CANDIDATES = 64;

export function parseJSON<T>(input: string): T {
  const cleanedInput = input.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  const firstBrace = cleanedInput.indexOf("{");
  const lastBrace = cleanedInput.lastIndexOf("}");

  // A model reply can carry prose on both sides of its arguments. The whole
  // first-brace..last-brace range is tried first, so every input that parsed
  // before parses the same way; when that prose itself contains a brace, each
  // balanced object region is tried in turn.
  const candidates: string[] = [];
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleanedInput.substring(firstBrace, lastBrace + 1));
    for (const candidate of balancedObjects(cleanedInput)) {
      if (candidates.length >= MAX_OBJECT_CANDIDATES) break;
      if (candidate !== candidates[0]) candidates.push(candidate);
    }
  }

  let failure: string | undefined;
  for (const candidate of candidates) {
    try {
      return JSON5.parse(candidate) as T;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    failure
      ? `No valid JSON object found in input: ${failure}`
      : "No valid JSON object found in input"
  );
}

interface AjvErrorLike {
  readonly instancePath?: string;
  readonly dataPath?: string;
  readonly message?: string;
}

function formatAjvErrors(errors: readonly AjvErrorLike[]): string {
  return errors
    .map((err) => {
      const errorPath = err.instancePath ?? err.dataPath ?? "";
      const path = errorPath ? errorPath.replace(/^\//, "") : "value";
      return `${path}: ${err.message ?? "validation failed"}`;
    })
    .join(", ");
}

export function validateJsonSchema<T>(
  data: unknown,
  schema: Readonly<Record<string, unknown>>
): { success: true; data: T } | { success: false; error: string } {
  const budgetError = getMcpJsonSchemaBudgetError(schema);
  if (budgetError) {
    return { success: false, error: budgetError };
  }

  try {
    const isolated = new Ajv({ allErrors: true });
    const validate = isolated.compile(schema);
    const valid = validate(data);

    if (!valid) {
      const errors = validate.errors ?? [];
      const errorMessage = formatAjvErrors(errors);
      return { success: false, error: errorMessage };
    }

    return { success: true, data: data as T };
  } catch (error) {
    // error-policy:J3 Ajv compile/evaluation of untrusted input must not 500 the loop
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `schema validation failed: ${message}` };
  }
}

export function stringifyJSON(value: unknown): string {
  return JSON.stringify(value);
}

export function assertJsonObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: Expected a JSON object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

export function parseStructuredModelOutput<T = Record<string, unknown>>(input: string): T {
  const errors: string[] = [];

  try {
    return parseJSON<T>(input);
  } catch {
    // error-policy:J3 untrusted model output — accumulate the parse failure and
    // rethrow a typed error below; never returns a fabricated object.
    errors.push("JSON object parse failed");
  }

  throw new Error(`No valid JSON object found: ${errors.join("; ")}`);
}
