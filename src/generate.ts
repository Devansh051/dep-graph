/**
 * Tool Dependency Graph Generator
 *
 * Reads a Composio toolkit catalog (JSON) and produces dependency_graph.json
 * expressing producer → consumer relationships between tools.
 *
 * Pipeline:
 *   catalog.json → normalize → extract inputs/outputs → match → score → [LLM validate] → edges → graph
 *
 * Usage:
 *   node --import tsx src/generate.ts path/to/catalog.json
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import OpenAI from "openai";

// ============================================================
// Types
// ============================================================

interface InputParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

interface OutputField {
  fieldName: string;       // e.g., "number"
  fieldPath: string;       // e.g., "Issue.number"
  type: string;            // JSON Schema type
  description: string;     // field description
  entityContext: string;   // parent $def name in snake_case, e.g., "issue"
  depth: number;           // how deep in the schema tree (0 = top-level response)
}

interface NormalizedTool {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  inputs: InputParam[];
  entityIdInputs: InputParam[];
  outputFields: OutputField[];
  service: string;
}

interface Node { id: string; service?: string; }
interface Edge { from: string; to: string; label?: string; }
interface Graph { nodes: Node[]; edges: Edge[]; }

interface CandidateEdge {
  from: string;
  to: string;
  label: string;
  score: number;
  reason: string;
  producerField: OutputField;
  consumerInput: InputParam;
}

// ============================================================
// Configuration
// ============================================================

const CATALOG_PATH = process.argv.length > 2
  ? process.argv[process.argv.length - 1]
  : undefined;
const OUT_PATH = "dependency_graph.json";

const HIGH_CONFIDENCE = 60;
const AMBIGUOUS_LOW = 30;
const LLM_BATCH_SIZE = 8;
// Keep validation bounded: deterministic scoring does the broad search and the
// Deterministic matching does the broad search. Keep model validation bounded
// so a large catalog cannot turn one generation run into hundreds of requests.
const MAX_LLM_CALLS = 40;

// ============================================================
// Utility helpers
// ============================================================

/** Convert PascalCase / camelCase to snake_case. */
function toSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

/**
 * Parse an entity-id parameter name into its entity prefix and field suffix.
 *   "issue_number"   → { entity: "issue",   field: "number" }
 *   "comment_id"     → { entity: "comment",  field: "id" }
 *   "commit_sha"     → { entity: "commit",   field: "sha" }
 *   "package_version_id" → { entity: "package_version", field: "id" }
 */
function parseEntityField(name: string): { entity: string; field: string } | null {
  const n = toSnake(name);
  const m = n.match(/^(.+?)_(id|number|sha|slug)$/);
  return m ? { entity: m[1], field: m[2] } : null;
}

/**
 * Check whether an entity context string (from a $def name) matches
 * the entity prefix parsed from a consumer's input parameter.
 *
 * Examples that should match:
 *   context="issue",           entity="issue"          → true
 *   context="pull_request",    entity="pull"           → true
 *   context="issue_comment",   entity="comment"        → true
 *   context="check_run",       entity="run"            → true (last word)
 *   context="workflow_run",    entity="run"            → true
 *   context="pull_request_simple", entity="pull"       → true
 *
 * Examples that should NOT match:
 *   context="runner",          entity="run"            → false
 *   context="user",            entity="comment"        → false
 */
function entityContextMatches(context: string, entity: string): boolean {
  const c = context.toLowerCase();
  const e = entity.toLowerCase();
  if (c === e) return true;
  // entity is a prefix: "pull" matches "pull_request"
  if (c.startsWith(e + "_")) return true;
  // entity matches the last word of a compound context
  const parts = c.split("_");
  if (parts.length > 1 && parts[parts.length - 1] === e) return true;
  // Multi-part entity check: all parts appear in context parts
  const eParts = e.split("_");
  if (eParts.length > 1 && eParts.every(p => parts.includes(p))) return true;
  return false;
}

/**
 * Check whether a producer tool is primarily about a given entity.
 *
 * Tags are deliberately not positive evidence here. They commonly represent
 * broad API areas (e.g. issue APIs also expose milestone operations) and can
 * otherwise turn a milestone number into an issue number dependency.
 */
function toolContextMatchesEntity(tool: NormalizedTool, entity: string): boolean {
  const e = entity.toLowerCase();
  const entityParts = e.split("_");
  const toolWords = toSnake(`${tool.slug}_${tool.name}`).split("_");

  // Every entity word must occur in the actual operation name, allowing the
  // usual English plural suffix. This stays catalog-independent while matching
  // forms such as "pull" and "pull_requests".
  return entityParts.every((part) =>
    toolWords.some((word) => word === part || word === `${part}s` || word === `${part}es`),
  );
}

/** Simple word-overlap score between two descriptions (0-1). */
function descriptionSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/**
 * Check whether a field's description explicitly mentions a given entity.
 * E.g., description "Issue number within the repository" mentions entity "issue".
 */
function descriptionMentionsEntity(desc: string, entity: string): boolean {
  if (!desc || !entity) return false;
  const d = desc.toLowerCase();
  const e = entity.toLowerCase();

  // Direct substring (word boundary)
  const regex = new RegExp(`\\b${e.replace(/_/g, "[_ ]?")}\\b`);
  if (regex.test(d)) return true;

  // Handle compound entities: "pull_request" → check for "pull request"
  if (e.includes("_")) {
    const spaced = e.replace(/_/g, " ");
    if (d.includes(spaced)) return true;
  }

  return false;
}

// ============================================================
// 1. Catalog loading
// ============================================================

function loadCatalog(): Record<string, any>[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

// ============================================================
// 2. Tool normalisation
// ============================================================

function normalizeTool(raw: any): NormalizedTool | null {
  const slug: string | undefined = raw.slug ?? raw.name ?? raw.function?.name;
  if (!slug) return null;

  const inputs = extractInputs(raw.inputParameters);
  const outputFields = extractOutputFields(raw.outputParameters);
  const service = inferService(raw);

  const tool: NormalizedTool = {
    slug,
    name: raw.name ?? slug,
    description: raw.description ?? "",
    tags: (raw.tags ?? []) as string[],
    inputs,
    entityIdInputs: [],  // filled below
    outputFields,
    service,
  };

  tool.entityIdInputs = inputs.filter(
    (inp) => inp.required && isEntityIdentifier(inp, tool),
  );

  return tool;
}

function extractInputs(schema: any): InputParam[] {
  if (!schema?.properties) return [];
  const required = new Set<string>(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
    name,
    type: prop.type ?? "string",
    description: prop.description ?? "",
    required: required.has(name),
  }));
}

// ============================================================
// 3. Input dependency extraction — is this an entity identifier?
// ============================================================

/**
 * Determine whether a required input parameter represents an entity identifier
 * that must come from another tool's output.
 *
 * Uses multiple signals (name patterns, descriptions, types) instead of a
 * single hard-coded exclusion list.
 */
function isEntityIdentifier(input: InputParam, tool: NormalizedTool): boolean {
  const name = input.name.toLowerCase();
  const desc = (input.description || "").toLowerCase();
  const type = (input.type || "").toLowerCase();
  let score = 0;

  // ── Positive: name structure ──
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)*_(id|number)$/.test(name)) score += 45;
  else if (/_(sha|sha256)$/.test(name)) score += 40;
  else if (name === "ref" && /\bcommit|tag|branch|sha\b/i.test(desc)) score += 15;

  // ── Positive: description language ──
  if (/\b(unique(ly)?|numeric(al)?)\s+(identifier|id|number)\b/.test(desc)) score += 20;
  if (/\b(identifier|id)\b.*\b(of|for|assigned|returned)\b/.test(desc)) score += 15;
  if (/\bnumber\b.*\b(of|for|identifying|within|that identifies)\b/.test(desc)) score += 15;
  if (/\breturned\b.*\b(when|by|from)\b/.test(desc)) score += 10;
  if (/\bget this\b.*\bby\b/.test(desc)) score += 10;
  if (/\bobtain\b.*\bfrom\b/.test(desc)) score += 10;

  // ── Positive: integer type with _id / _number suffix ──
  if (type === "integer" && /_(id|number)$/.test(name)) score += 10;

  // ── Negative: user-provided / content parameters (pattern-based) ──
  if (/^(owner|repo|org|username)$/.test(name)) score -= 50;
  if (/^(body|title|message|description|content|text|note|summary)$/.test(name)) score -= 50;
  if (/^(q|query|search|filter)$/.test(name)) score -= 50;
  if (/^(page|per_page|sort|direction|order|since|until|before|after|cursor)$/.test(name)) score -= 50;
  if (/^(state|status|type|format|visibility|permission|role|affiliation|side|subject_type)$/.test(name)) score -= 50;
  if (/^(draft|locked|archived|private|active|enabled|required|position|line)$/.test(name)) score -= 50;
  if (/^(base|head|path|branch|tag_name|target_commitish)$/.test(name)) score -= 35;
  if (/^(name|labels|assignees|reviewers|teams|file|files)$/.test(name)) score -= 40;
  // multi-word user-provided
  if (/^(commit_title|commit_message|merge_method|media_type)$/.test(name)) score -= 40;

  // ── Negative: description patterns indicating user-provided value ──
  if (/\brepository\s+(name|owner)\b/.test(desc) && !/\bid\b/.test(desc)) score -= 30;
  if (/\borganization\s+(name|login)\b/.test(desc) && !/\bid\b/.test(desc)) score -= 30;
  if (/\bnot\s+case[- ]?sensitive\b/.test(desc)) score -= 20;
  if (/\b(markdown|free[- ]?form|text content|html)\b/.test(desc)) score -= 20;
  if (/\bfilter\b|\bpagination\b|\bsort\b/.test(desc) && !/\bid\b/.test(desc)) score -= 20;

  // ── Negative: boolean / enum / array types usually not entity IDs ──
  if (type === "boolean") score -= 50;
  if (type === "array") score -= 30;

  return score > 15;
}

// ============================================================
// 4. Output field extraction — walk JSON Schema with $defs
// ============================================================

function extractOutputFields(outputParams: any): OutputField[] {
  if (!outputParams) return [];

  const defs: Record<string, any> = outputParams.$defs || {};
  const fields: OutputField[] = [];
  const visited = new Set<string>();

  // Start from the main response. Only fields reachable from it are genuine
  // productions: catalogs may include unreferenced helper definitions.
  const dataRef = outputParams.properties?.data?.$ref;
  if (dataRef) {
    const refName = dataRef.replace("#/$defs/", "");
    if (defs[refName]) walkDef(refName, defs[refName], defs, fields, visited, 0);
  }

  // Support catalogs that put response data inline instead of behind a ref.
  if (!dataRef && outputParams.properties?.data) {
    walkDef("data", outputParams.properties.data, defs, fields, visited, 0);
  }

  return fields;
}

function walkDef(
  defName: string,
  schema: any,
  defs: Record<string, any>,
  fields: OutputField[],
  visited: Set<string>,
  depth: number,
): void {
  if (depth > 5 || !schema || visited.has(defName)) return;
  visited.add(defName);

  const entityCtx = extractEntityFromDefName(defName);
  const props = schema.properties || {};

  for (const [name, prop] of Object.entries(props)) {
    const p = prop as any;

    fields.push({
      fieldName: name,
      fieldPath: `${defName}.${name}`,
      type: p.type || (p.$ref ? "object" : p.items ? "array" : "unknown"),
      description: p.description || "",
      entityContext: entityCtx,
      depth,
    });

    // Follow $ref
    if (p.$ref) {
      const rn = p.$ref.replace("#/$defs/", "");
      if (defs[rn]) walkDef(rn, defs[rn], defs, fields, visited, depth + 1);
    }
    // Follow items.$ref (arrays)
    if (p.items?.$ref) {
      const rn = p.items.$ref.replace("#/$defs/", "");
      if (defs[rn]) walkDef(rn, defs[rn], defs, fields, visited, depth + 1);
    }
    // Inline nested objects
    if (p.properties && !p.$ref) {
      walkDef(`${defName}_${name}`, p, defs, fields, visited, depth + 1);
    }
    // Inline array items with properties
    if (p.items?.properties && !p.items.$ref) {
      walkDef(`${defName}_${name}_item`, p.items, defs, fields, visited, depth + 1);
    }
  }
}

/**
 * Extract a meaningful entity name from a $def name.
 *
 * Examples:
 *   "Issue"                     → "issue"
 *   "CreateAnIssueResponse"     → "issue"
 *   "ListRepositoryIssuesResponse" → "issue"
 *   "PullRequestSimple"         → "pull_request"
 *   "GetPullRequestResponse"    → "pull_request"
 *   "User"                      → "user"
 *   "Milestone"                 → "milestone"
 *   "CheckRun"                  → "check_run"
 *   "WorkflowRun"               → "workflow_run"
 */
function extractEntityFromDefName(defName: string): string {
  // Strip response/wrapper suffixes
  let clean = defName
    .replace(/Response(Wrapper)?$/i, "")
    .replace(/Request$/i, "");

  // Strip common CRUD/action prefixes
  clean = clean
    .replace(/^(List|Get|Create|Update|Delete|Search|Check|Add|Remove|Set|Enable|Disable)/i, "")
    .replace(/^(An?|The|All|For|By|In|Of|To|With|From)(?=[A-Z])/g, "");

  // Strip ownership context prefixes (these precede the entity)
  clean = clean
    .replace(/^(Repository|Repo|Organization|Org|User|Team|Enterprise|Authenticated)/i, "")
    .replace(/^(An?|The|All|For|By|In|Of|To|With|From)(?=[A-Z])/g, "");

  // If everything was stripped, fall back to raw name
  if (!clean || clean.length < 2) clean = defName.replace(/Response(Wrapper)?$/i, "");
  if (!clean || clean.length < 2) clean = defName;

  return toSnake(clean);
}

// ============================================================
// 5. Service / domain inference
// ============================================================

function inferService(raw: any): string {
  const tags: string[] = (raw.tags ?? []);
  // Skip hint/meta tags — pick the first substantive tag
  const skip = /hint$/i;
  const meta = new Set(["important", "deprecated", "batch", "lookup", "node",
    "resource", "mutation", "relay", "status", "mcpIgnore"]);

  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (skip.test(lower) || meta.has(lower)) continue;
    if (tag === lower && tag.length >= 2 && tag.length <= 25) return tag;
  }
  // Fallback: first non-hint tag (title-case → snake)
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (!skip.test(lower) && !meta.has(lower)) {
      return lower.replace(/\s+/g, "_");
    }
  }
  return "other";
}

// ============================================================
// 6. Candidate matching & scoring
// ============================================================

/**
 * Build an index of output fields by field name for efficient lookup.
 */
function buildOutputIndex(
  tools: NormalizedTool[],
): Map<string, Array<{ tool: NormalizedTool; field: OutputField }>> {
  const idx = new Map<string, Array<{ tool: NormalizedTool; field: OutputField }>>();
  for (const tool of tools) {
    for (const f of tool.outputFields) {
      const key = f.fieldName.toLowerCase();
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key)!.push({ tool, field: f });
    }
  }
  return idx;
}

/**
 * For every consumer tool's entity-ID input, find candidate producer tools
 * and score them.
 */
function findAllCandidates(
  tools: NormalizedTool[],
  outputIndex: Map<string, Array<{ tool: NormalizedTool; field: OutputField }>>,
): CandidateEdge[] {
  const candidates: CandidateEdge[] = [];

  for (const consumer of tools) {
    for (const input of consumer.entityIdInputs) {
      const parsed = parseEntityField(input.name);

      // Strategy A: exact / normalised field match
      const exactHits = outputIndex.get(input.name.toLowerCase()) || [];
      for (const { tool: producer, field } of exactHits) {
        if (producer.slug === consumer.slug) continue;
        const score = scoreMatch(producer, field, consumer, input, parsed, "exact");
        if (score.confidence >= AMBIGUOUS_LOW) {
          candidates.push(makeCandidate(producer, consumer, input, field, score));
        }
      }

      // Strategy B: suffix match (e.g., "number" from "issue_number")
      if (parsed) {
        const suffixHits = outputIndex.get(parsed.field) || [];
        for (const { tool: producer, field } of suffixHits) {
          if (producer.slug === consumer.slug) continue;
          // Skip if already covered by exact match
          if (field.fieldName.toLowerCase() === input.name.toLowerCase()) continue;
          const score = scoreMatch(producer, field, consumer, input, parsed, "suffix");
          if (score.confidence >= AMBIGUOUS_LOW) {
            candidates.push(makeCandidate(producer, consumer, input, field, score));
          }
        }
      }
    }
  }

  return candidates;
}

function makeCandidate(
  producer: NormalizedTool,
  consumer: NormalizedTool,
  input: InputParam,
  field: OutputField,
  score: { confidence: number; reason: string },
): CandidateEdge {
  return {
    from: producer.slug,
    to: consumer.slug,
    label: input.name,
    score: score.confidence,
    reason: score.reason,
    producerField: field,
    consumerInput: input,
  };
}

/**
 * Multi-signal scoring for a producer-output → consumer-input match.
 */
function scoreMatch(
  producer: NormalizedTool,
  outputField: OutputField,
  consumer: NormalizedTool,
  consumerInput: InputParam,
  parsed: { entity: string; field: string } | null,
  matchType: "exact" | "suffix",
): { confidence: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // ── Level 1: Exact field name ──
  if (matchType === "exact") {
    score += 90;
    reasons.push("exact name match");
  }

  // ── Level 2: Normalised field name ──
  if (
    matchType !== "exact" &&
    toSnake(outputField.fieldName) === toSnake(consumerInput.name)
  ) {
    score += 80;
    reasons.push("normalised name match");
  }

  // ── Level 3: Suffix match + entity context ──
  if (matchType === "suffix" && parsed) {
    // Does the output field's entity context match the input's entity prefix?
    if (entityContextMatches(outputField.entityContext, parsed.entity)) {
      score += 70;
      reasons.push(`entity context "${outputField.entityContext}" matches "${parsed.entity}"`);
    } else if (descriptionMentionsEntity(outputField.description, parsed.entity)) {
      // Output field description explicitly mentions the entity
      score += 65;
      reasons.push(`output desc mentions entity "${parsed.entity}"`);
    } else if (toolContextMatchesEntity(producer, parsed.entity)) {
      // The tool itself is related to the entity (name/tags match)
      score += 55;
      reasons.push(`tool context matches entity "${parsed.entity}"`);
    } else {
      // Generic suffix match with no context — weak
      score += 10;
      reasons.push("suffix match only, no entity context");
    }
  }

  // ── Level 4: Description similarity ──
  const descSim = descriptionSimilarity(
    outputField.description,
    consumerInput.description,
  );
  if (descSim > 0.3) {
    score += Math.round(descSim * 15);
    reasons.push(`desc similarity ${descSim.toFixed(2)}`);
  }

  // ── Type compatibility ──
  if (
    outputField.type &&
    consumerInput.type &&
    outputField.type !== "unknown"
  ) {
    if (outputField.type === consumerInput.type) {
      score += 5;
    } else if (
      (outputField.type === "integer" && consumerInput.type === "string") ||
      (outputField.type === "string" && consumerInput.type === "integer")
    ) {
      // Slight mismatch but could be coerced
      score -= 5;
    } else {
      score -= 15;
      reasons.push("type mismatch");
    }
  }

  // ── Domain compatibility boost ──
  if (producer.service === consumer.service && producer.service !== "other") {
    score += 5;
    reasons.push("same service");
  }

  // ── Penalty for overly generic output context ──
  if (
    matchType === "suffix" &&
    parsed &&
    (parsed.field === "id" || parsed.field === "number") &&
    !entityContextMatches(outputField.entityContext, parsed.entity) &&
    !descriptionMentionsEntity(outputField.description, parsed.entity) &&
    !toolContextMatchesEntity(producer, parsed.entity)
  ) {
    score -= 20;
    reasons.push("generic field, no context match");
  }

  // ── Incidental entity penalty ──
  // If the entity context matches BUT the producer tool is NOT primarily about
  // that entity (i.e., the entity appears only as a nested object in the output),
  // apply a penalty. This catches cases like:
  //   - Issue-listing tool → outputs Repository.id → should NOT match repository_id consumers
  //   - PR-listing tool → outputs User.id → should NOT match user_id consumers
  if (
    matchType === "suffix" &&
    parsed &&
    entityContextMatches(outputField.entityContext, parsed.entity) &&
    !toolContextMatchesEntity(producer, parsed.entity) &&
    outputField.depth >= 1
  ) {
    const penalty = Math.min(35, outputField.depth * 15);
    score -= penalty;
    reasons.push(`incidental entity at depth ${outputField.depth}, penalty -${penalty}`);
  }

  return { confidence: score, reason: reasons.join("; ") };
}

// ============================================================
// 7. LLM validation for ambiguous candidates
// ============================================================

async function validateWithLLM(
  ambiguous: CandidateEdge[],
  toolMap: Map<string, NormalizedTool>,
): Promise<CandidateEdge[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!apiKey || !baseURL) {
    console.error("[LLM] No API credentials found — skipping LLM validation");
    return [];
  }

  const client = new OpenAI({ apiKey, baseURL });
  const validated: CandidateEdge[] = [];

  // Sort by score descending — validate the most promising ones first
  ambiguous.sort((a, b) => b.score - a.score);

  const batches: CandidateEdge[][] = [];
  for (let i = 0; i < ambiguous.length && batches.length < MAX_LLM_CALLS; i += LLM_BATCH_SIZE) {
    batches.push(ambiguous.slice(i, i + LLM_BATCH_SIZE));
  }

  console.error(`[LLM] Validating ${ambiguous.length} ambiguous candidates in ${batches.length} batches…`);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    try {
      const pairsText = batch.map((c, i) => {
        const prod = toolMap.get(c.from);
        const cons = toolMap.get(c.to);
        return [
          `Pair ${i + 1}:`,
          `  Producer: "${prod?.name}" — ${prod?.description?.slice(0, 150)}`,
          `  Output field: "${c.producerField.fieldPath}" (type: ${c.producerField.type})`,
          `  Output desc: "${c.producerField.description?.slice(0, 150)}"`,
          `  Consumer: "${cons?.name}" — ${cons?.description?.slice(0, 150)}`,
          `  Required input: "${c.consumerInput.name}" (type: ${c.consumerInput.type})`,
          `  Input desc: "${c.consumerInput.description?.slice(0, 150)}"`,
        ].join("\n");
      }).join("\n\n");

      const response = await client.chat.completions.create({
        model: "openai/gpt-4o",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You validate tool dependency relationships. For each pair, decide whether the producer tool's output field can provide the value needed by the consumer tool's required input. Respond with a JSON array (one object per pair) with fields: "index" (1-based), "match" (boolean), "confidence" (0-1), "reason" (brief).`,
          },
          {
            role: "user",
            content: `Validate these ${batch.length} candidate dependencies:\n\n${pairsText}\n\nRespond ONLY with a JSON array.`,
          },
        ],
      });

      const text = response.choices?.[0]?.message?.content ?? "";
      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const results: Array<{ index: number; match: boolean; confidence: number; reason: string }> =
          JSON.parse(jsonMatch[0]);
        for (const r of results) {
          const idx = r.index - 1;
          if (idx >= 0 && idx < batch.length && r.match && r.confidence >= 0.6) {
            const c = { ...batch[idx], score: r.confidence * 100, reason: r.reason };
            validated.push(c);
          }
        }
      }
      console.error(`  batch ${bi + 1}/${batches.length}: ${validated.length} validated so far`);
    } catch (err: any) {
      console.error(`  batch ${bi + 1} failed: ${err.message}`);
    }
  }

  return validated;
}

// ============================================================
// 8. Edge generation & deduplication
// ============================================================

function generateEdges(candidates: CandidateEdge[]): Edge[] {
  // Keep best score per (from, to, label) triple
  const best = new Map<string, CandidateEdge>();
  for (const c of candidates) {
    const key = `${c.from}|${c.to}|${c.label}`;
    const existing = best.get(key);
    if (!existing || c.score > existing.score) {
      best.set(key, c);
    }
  }

  // Remove self-edges (already filtered, but belt-and-suspenders)
  const edges: Edge[] = [];
  for (const c of best.values()) {
    if (c.from !== c.to) {
      edges.push({ from: c.from, to: c.to, label: c.label });
    }
  }

  return edges.sort((a, b) =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label!.localeCompare(b.label!),
  );
}

// ============================================================
// 9. Main pipeline
// ============================================================

async function generate(rawTools: Record<string, any>[]): Promise<Graph> {
  console.error(`[1/7] Normalising ${rawTools.length} tools…`);
  const tools = rawTools
    .map(normalizeTool)
    .filter((t): t is NormalizedTool => t !== null);
  console.error(`  → ${tools.length} tools normalised`);

  // Build tool map for quick lookup
  const toolMap = new Map<string, NormalizedTool>();
  for (const t of tools) toolMap.set(t.slug, t);

  console.error("[2/7] Extracting entity-ID inputs…");
  const totalEntityInputs = tools.reduce((s, t) => s + t.entityIdInputs.length, 0);
  console.error(`  → ${totalEntityInputs} entity-ID inputs across all tools`);

  console.error("[3/7] Indexing output fields…");
  const outputIndex = buildOutputIndex(tools);
  const totalOutputFields = tools.reduce((s, t) => s + t.outputFields.length, 0);
  console.error(`  → ${totalOutputFields} output fields indexed (${outputIndex.size} unique names)`);

  console.error("[4/7] Finding candidate matches…");
  const allCandidates = findAllCandidates(tools, outputIndex);
  console.error(`  → ${allCandidates.length} raw candidates`);

  // Split into strong and ambiguous
  const strong = allCandidates.filter((c) => c.score >= HIGH_CONFIDENCE);
  const ambiguous = allCandidates.filter(
    (c) => c.score >= AMBIGUOUS_LOW && c.score < HIGH_CONFIDENCE,
  );
  console.error(`  → ${strong.length} strong, ${ambiguous.length} ambiguous`);

  console.error("[5/7] LLM validation for ambiguous candidates…");
  const llmValidated = await validateWithLLM(ambiguous, toolMap);
  console.error(`  → ${llmValidated.length} validated by LLM`);

  const accepted = [...strong, ...llmValidated];
  console.error(`[6/7] Generating edges from ${accepted.length} accepted candidates…`);
  const edges = generateEdges(accepted);
  console.error(`  → ${edges.length} unique edges`);

  console.error("[7/7] Building graph…");
  const nodes: Node[] = tools.map((t) => ({ id: t.slug, service: t.service }));

  return { nodes, edges };
}

async function main() {
  const rawTools = loadCatalog();
  const graph = await generate(rawTools);
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(
    `\nWrote ${graph.nodes.length} nodes, ${graph.edges.length} edges → ${OUT_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
