import YAML from "yaml";
import {
  type CompositionDocument,
  type PortableCompositionBundle,
  type ProtocolValidationResult,
  type SubjectManifest,
  type ValidationContext,
} from "./types.ts";
import {
  validateCompositionDocument,
  validatePortableBundle,
  validateSubjectManifest,
} from "./validator.ts";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = sortKeysDeep(v);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function serializeCompositionJson(doc: CompositionDocument): string {
  return JSON.stringify(sortKeysDeep(doc), null, 2);
}

export function serializeCompositionYaml(doc: CompositionDocument): string {
  return YAML.stringify(sortKeysDeep(doc));
}

export function parseCompositionJson(
  text: string,
  context?: ValidationContext,
): ProtocolValidationResult<CompositionDocument> {
  try {
    const parsed: unknown = JSON.parse(text);
    return validateCompositionDocument(parsed, context);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "PARSE_ERROR",
          path: "$",
          message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

export function parseCompositionYaml(
  text: string,
  context?: ValidationContext,
): ProtocolValidationResult<CompositionDocument> {
  try {
    const parsed: unknown = YAML.parse(text);
    return validateCompositionDocument(parsed, context);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "PARSE_ERROR",
          path: "$",
          message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

export function parseSubjectYaml(
  text: string,
  context?: ValidationContext,
): ProtocolValidationResult<SubjectManifest> {
  try {
    const parsed: unknown = YAML.parse(text);
    return validateSubjectManifest(parsed, context);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "PARSE_ERROR",
          path: "$",
          message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

export function serializeBundleInterchange(
  bundle: PortableCompositionBundle,
  format: "json" | "yaml",
): string {
  const canonicalObj = sortKeysDeep(bundle);
  return format === "yaml"
    ? YAML.stringify(canonicalObj)
    : JSON.stringify(canonicalObj, null, 2);
}

export function parseBundleInterchange(
  text: string,
  format: "json" | "yaml",
  context?: ValidationContext,
): ProtocolValidationResult<PortableCompositionBundle> {
  try {
    const parsed: unknown = format === "yaml" ? YAML.parse(text) : JSON.parse(text);
    return validatePortableBundle(parsed, context);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          code: "PARSE_ERROR",
          path: "$",
          message: `Invalid ${format.toUpperCase()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }
}
