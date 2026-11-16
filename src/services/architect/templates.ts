// Template-source adapters (spec §8.3, §8.4; TODO 5.2; ARCH 2026-11-16, sources and
// template import): list the templates of a registered source and import one as a draft
// recipe with a conversion report.
//
// Two adapters: `comfyui_template_index` reads the index the target ComfyUI serves at the
// source's registered root and a workflow next to it; `upstream_packs` reads the packs
// upstream ships, by upstream's own enumeration. A source is read only at its registered
// root, never at a URL or path taken from content. Nothing is executed or installed.
//
// An import is a draft: certification `proposed`, revision 1, no model pins. Text in a
// template (notes, titles, descriptions, the index's prose) is data and never decides
// what the import does (SEC T2); the recipe takes no text from it but the graph's own
// literals, and its labels and title are made from the template's name and node classes.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, sep } from "node:path";
import { z } from "zod";
import type { ObjectInfo } from "../../comfyui/types.js";
import { sha256Hex } from "./hash.js";
import { ApiGraph, ImageOperation, Recipe, type RecipeSlot, type SourceRegistryEntry, type WorkflowKind } from "./schemas.js";
import type { ArchitectStore } from "./store.js";
import {
  FRONTEND_NOTE_NODE_TYPES,
  RESOLVED_VIRTUAL_NODE_TYPES,
  type PackManifestModel,
  type UpstreamFacade,
  isApiWorkflow,
  isUiWorkflow,
  looksLikeModelFile,
  uiToApi,
} from "./upstream.js";

/** The largest template index read: the reference target's is about 850 KB. */
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;
/** The largest workflow file read. */
export const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;

/** A template or pack name: one path segment, as both sources name their files. */
export const TemplateName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "expected a template name of letters, digits, dots, dashes and underscores")
  .refine((n) => !n.includes(".."), { message: "a template name has no '..'" });

/** One template a source lists. */
export const TemplateListEntry = z
  .object({
    name: z.string().min(1),
    /** The source's title, as data; for display only. */
    title: z.string(),
    /** The index category or the pack's family. */
    category: z.string().optional(),
    /** The kind of workflow, when the source's metadata names one Architect knows. */
    kind: z.enum(["image", "video", "audio", "3d", "pipeline"]).optional(),
    tags: z.array(z.string()),
    /** The image operations the source's tags or pack kind map to; empty when none does. */
    operations: z.array(ImageOperation),
    /** Model names as the index labels them (`Z-Image-Turbo`): families, not files. */
    modelLabels: z.array(z.string()),
    /** Model files a pack's manifest lists, by folder; the index lists none before import. */
    modelFiles: z.array(z.object({ name: z.string().min(1), directory: z.string().min(1) }).strict()).optional(),
    /** Why a pack's manifest couldn't be read: its model files are unknown, not none. */
    modelFilesUnknown: z.string().optional(),
    /** The bytes of model files the index says the template needs. */
    sizeBytes: z.number().int().nonnegative().optional(),
    /** Whether an import can read a workflow for it: a valid name and, for a pack, a workflow file. */
    importable: z.boolean(),
  })
  .strict();
export type TemplateListEntry = z.infer<typeof TemplateListEntry>;

/** A listing, or why the source couldn't be read: an unreachable source is never empty. */
export type TemplateListing =
  | { ok: true; source: SourceRegistryEntry; templates: TemplateListEntry[]; skipped: { where: string; problem: string }[] }
  | { ok: false; source: SourceRegistryEntry; reason: string };

const NodeRef = {
  nodeId: z.string().min(1),
  /** The subgraph definition the node sits in; absent at the top level. */
  subgraph: z.string().optional(),
};

/**
 * What an import did with a template (spec §8.4): the content it read, what it dropped,
 * resolved or couldn't support, the node classes the target lacks, the template's model
 * list as candidate sources, and what a maintainer has to decide. Names node ids and types,
 * never the text of a note or title.
 */
export const TemplateConversionReport = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: z.string().min(1),
    name: z.string().min(1),
    /** The workflow's format; `unknown` when it isn't JSON. */
    format: z.enum(["ui", "api", "unknown"]),
    /** The content read: its sha256, and the index entry's date when the index gives one. */
    revision: z.object({ contentSha256: z.string().regex(/^[0-9a-f]{64}$/), indexDate: z.string().optional() }).strict(),
    importedAt: z.string().datetime({ offset: true }),
    outcome: z.enum(["draft", "failed"]),
    recipeId: z.string().optional(),
    /** Why the import made no recipe; empty for a draft. */
    failures: z.array(z.string()),
    /** Nodes the executable graph doesn't hold: notes, muted and bypassed nodes, unused subgraphs. */
    dropped: z.array(z.object({ ...NodeRef, type: z.string(), reason: z.enum(["note", "muted", "bypassed", "unused_subgraph"]) }).strict()),
    /** Virtual nodes upstream's converter folds into links or widget values. */
    resolved: z.array(z.object({ ...NodeRef, type: z.string() }).strict()),
    /** Constructs the import doesn't support; each one fails it. */
    unsupported: z.array(
      z.object({ ...NodeRef, type: z.string(), construct: z.enum(["unknown_virtual_node", "unknown_subgraph", "unknown_mode", "malformed_node"]), detail: z.string() }).strict(),
    ),
    /** Node classes the target's object_info doesn't have, with the pack the node names. */
    missingNodeClasses: z.array(z.object({ ...NodeRef, classType: z.string(), pack: z.string().optional() }).strict()),
    /**
     * The template's model list. Candidate sources only: a URL here is text from the
     * template, on a branch or mirror, never a pin; the recipe's `modelSources` stay empty.
     */
    candidateSources: z.array(z.object({ name: z.string(), directory: z.string().optional(), url: z.string().optional(), nodeId: z.string().optional() }).strict()),
    /** What became a slot, so a reviewer sees the bindings at a glance. */
    slots: z.array(z.object({ id: z.string(), valueType: z.string(), node: z.string(), input: z.string() }).strict()),
    /** What the import couldn't decide and left as written. */
    needsMaintainer: z.array(z.string()),
    /** Upstream's converter warnings, as it wrote them. */
    converterWarnings: z.array(z.string()),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.outcome === "draft") !== (r.failures.length === 0 && r.recipeId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "a draft has a recipe id and no failures; a failed import has failures", path: ["outcome"] });
    }
  });
export type TemplateConversionReport = z.infer<typeof TemplateConversionReport>;

/** An import's result: a draft recipe with its report, or the report of a failed import. */
export type TemplateImport = { ok: true; recipe: Recipe; report: TemplateConversionReport } | { ok: false; report: TemplateConversionReport };

/** A refusal before any template content was read, with a stable code. */
export class TemplateSourceError extends Error {
  constructor(
    readonly code: "UNKNOWN_SOURCE" | "OPERATION_NOT_ALLOWED" | "SOURCE_UNAVAILABLE" | "NOT_LISTED" | "UNREADABLE" | "SCHEMAS_UNAVAILABLE" | "INVALID_NAME",
    message: string,
  ) {
    super(message);
    this.name = "TemplateSourceError";
  }
}

/** What the adapters need: the source registry, the facade and a clock. */
export interface TemplateDeps {
  store: Pick<ArchitectStore, "getSource" | "recordSourceRefresh">;
  upstream: Pick<UpstreamFacade, "objectInfo" | "fetchFromTarget" | "listPacks" | "packWorkflowFile" | "packManifestModels">;
  now: () => Date;
}

// ---------------------------------------------------------------------------------------
// Source metadata

/** Index tags that name one image operation. Tags not listed here map to none. */
const TAG_OPERATIONS: Readonly<Record<string, ImageOperation>> = {
  "Text to Image": "text_to_image",
  "Image Edit": "image_edit",
  Inpainting: "inpaint",
  "Image Upscale": "upscale",
  Upscaling: "upscale",
  "Style Reference": "reference_guided",
  "Character Reference": "reference_guided",
};

/** Pack kinds (pack.yaml `kind`) that name one image operation. */
const PACK_KIND_OPERATIONS: Readonly<Record<string, ImageOperation>> = {
  txt2img: "text_to_image",
  img2img: "image_edit",
  edit: "image_edit",
  inpaint: "inpaint",
};

const KINDS: readonly WorkflowKind[] = ["image", "video", "audio", "3d", "pipeline"];

function operationsOf(tags: readonly string[]): ImageOperation[] {
  return [...new Set(tags.flatMap((t) => (TAG_OPERATIONS[t] ? [TAG_OPERATIONS[t]] : [])))];
}

const IndexTemplate = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
    models: z.array(z.string()).optional(),
    size: z.number().nonnegative().optional(),
    date: z.string().optional(),
  })
  .passthrough();

const IndexCategory = z
  .object({ type: z.string().optional(), category: z.string().optional(), title: z.string().optional(), templates: z.array(z.unknown()) })
  .passthrough();

const TemplateIndex = z.array(z.unknown());

/** An index entry with the category it sits in. */
interface IndexedTemplate {
  entry: TemplateListEntry;
  date?: string;
}

// ---------------------------------------------------------------------------------------
// Reading

/** The body of a response, refused when it is larger than `max` bytes. */
async function boundedText(res: Response, max: number, what: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new Error(`${what} is ${declared} bytes, more than the ${max} read`);
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`${what} is more than the ${max} bytes read`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function fetchText(deps: TemplateDeps, url: string, max: number, what: string): Promise<string> {
  const res = await deps.upstream.fetchFromTarget(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return await boundedText(res, max, what);
}

function requireSource(deps: TemplateDeps, sourceId: string, op: "list" | "import"): SourceRegistryEntry {
  const source = deps.store.getSource(sourceId);
  if (!source) throw new TemplateSourceError("UNKNOWN_SOURCE", `no source ${sourceId} is registered`);
  if (!source.allowedOps.includes(op)) throw new TemplateSourceError("OPERATION_NOT_ALLOWED", `source ${sourceId} doesn't allow ${op}`);
  if (source.adapter !== "comfyui_template_index" && source.adapter !== "upstream_packs") {
    throw new TemplateSourceError("OPERATION_NOT_ALLOWED", `source ${sourceId} (${source.adapter}) holds no templates`);
  }
  return source;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The index's entries, or a thrown reason the index can't be read. */
async function readIndex(deps: TemplateDeps, source: SourceRegistryEntry) {
  const text = await fetchText(deps, source.root, MAX_INDEX_BYTES, "the template index");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${source.root} isn't JSON`);
  }
  const categories = TemplateIndex.safeParse(raw);
  if (!categories.success) throw new Error(`${source.root} isn't a list of template categories`);
  const templates: IndexedTemplate[] = [];
  const skipped: { where: string; problem: string }[] = [];
  categories.data.forEach((c, ci) => {
    const cat = IndexCategory.safeParse(c);
    if (!cat.success) {
      skipped.push({ where: `category ${ci}`, problem: "not a category with a templates list" });
      return;
    }
    const kind = KINDS.find((k) => k === cat.data.type);
    cat.data.templates.forEach((t, ti) => {
      const parsed = IndexTemplate.safeParse(t);
      if (!parsed.success) {
        skipped.push({ where: `category ${ci} template ${ti}`, problem: "not a template entry with a name" });
        return;
      }
      const tags = parsed.data.tags ?? [];
      const size = parsed.data.size;
      templates.push({
        entry: {
          name: parsed.data.name,
          title: parsed.data.title ?? parsed.data.name,
          ...(cat.data.title ? { category: cat.data.title } : {}),
          ...(kind ? { kind } : {}),
          tags,
          operations: kind === "image" ? operationsOf(tags) : [],
          modelLabels: parsed.data.models ?? [],
          ...(size !== undefined && Number.isInteger(size) ? { sizeBytes: size } : {}),
          importable: TemplateName.safeParse(parsed.data.name).success,
        },
        ...(parsed.data.date ? { date: parsed.data.date } : {}),
      });
    });
  });
  return { templates, skipped };
}

/** A pack manifest's models as folder and file, or the reason they can't be named. */
function packModelFiles(models: readonly PackManifestModel[]): { files: { name: string; directory: string }[]; unnamed: string[] } {
  const files: { name: string; directory: string }[] = [];
  const unnamed: string[] = [];
  for (const m of models) {
    const local = m.localPath?.split("/");
    if (local && local.length >= 2 && local.every((s) => s.length > 0)) {
      files.push({ directory: local[0], name: local.slice(1).join("/") });
    } else if (m.modelType && (m.filename ?? basename(new URL(m.url).pathname))) {
      files.push({ directory: m.modelType, name: m.filename ?? basename(new URL(m.url).pathname) });
    } else {
      unnamed.push(m.url);
    }
  }
  return { files, unnamed };
}

/** The packs folder, checked: a missing folder is an unavailable source, not one without packs. */
function requirePacksRoot(source: SourceRegistryEntry): string {
  const info = statSync(source.root, { throwIfNoEntry: false });
  if (!info) throw new Error(`${source.root} doesn't exist`);
  if (!info.isDirectory()) throw new Error(`${source.root} isn't a directory`);
  return realpathSync(source.root);
}

async function readPacks(deps: TemplateDeps, source: SourceRegistryEntry) {
  requirePacksRoot(source);
  const templates: IndexedTemplate[] = [];
  const skipped: { where: string; problem: string }[] = [];
  for (const p of deps.upstream.listPacks()) {
    const tags = [p.kind, p.family].filter((t): t is string => t !== undefined);
    const op = p.kind ? PACK_KIND_OPERATIONS[p.kind] : undefined;
    let models: { modelFiles: { name: string; directory: string }[] } | { modelFilesUnknown: string };
    try {
      const listed = await deps.upstream.packManifestModels(p.name);
      if (listed === undefined) {
        models = { modelFilesUnknown: "the pack has no manifest" };
      } else {
        const { files, unnamed } = packModelFiles(listed);
        models = unnamed.length === 0 ? { modelFiles: files } : { modelFilesUnknown: `the manifest names no folder for ${unnamed.length} model URL(s)` };
      }
    } catch (err) {
      models = { modelFilesUnknown: `the manifest couldn't be read: ${message(err)}` };
    }
    templates.push({
      entry: {
        name: p.name,
        title: p.displayName ?? p.name,
        ...(p.family ? { category: p.family } : {}),
        ...(op ? { kind: "image" as const } : {}),
        tags,
        operations: op ? [op] : [],
        modelLabels: [],
        ...models,
        importable: p.hasWorkflow && TemplateName.safeParse(p.name).success,
      },
    });
  }
  return { templates, skipped };
}

/**
 * List the templates of a registered source, and record the refresh on it: `ok` when it
 * was read, `unavailable` with the reason when it wasn't. An unreadable source is returned
 * as `ok: false`, never as an empty list (spec §8.5).
 */
export async function listTemplates(deps: TemplateDeps, sourceId: string): Promise<TemplateListing> {
  const source = requireSource(deps, sourceId, "list");
  try {
    const { templates, skipped } = source.adapter === "comfyui_template_index" ? await readIndex(deps, source) : await readPacks(deps, source);
    const refreshed = deps.store.recordSourceRefresh({ id: source.id, at: deps.now(), outcome: { ok: true } });
    return { ok: true, source: refreshed, templates: templates.map((t) => t.entry), skipped };
  } catch (err) {
    const reason = message(err);
    const refreshed = deps.store.recordSourceRefresh({ id: source.id, at: deps.now(), outcome: { ok: false, reason } });
    return { ok: false, source: refreshed, reason };
  }
}

// ---------------------------------------------------------------------------------------
// Import

const UiNodeScan = z
  .object({
    id: z.union([z.number(), z.string()]),
    type: z.string().min(1),
    mode: z.number().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type UiNodeScan = z.infer<typeof UiNodeScan>;

const SubgraphScan = z.object({ id: z.string().min(1), nodes: z.array(z.unknown()) }).passthrough();

const ModelEntry = z.object({ name: z.string().min(1), url: z.string().optional(), directory: z.string().optional() }).passthrough();

const UiScan = z
  .object({
    nodes: z.array(z.unknown()),
    definitions: z.object({ subgraphs: z.array(z.unknown()).optional() }).passthrough().optional(),
    models: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Folder names a `model_file` slot may carry: one segment, as ComfyUI's model folders. */
const MODEL_FOLDER = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Report = Omit<TemplateConversionReport, "outcome" | "recipeId" | "importedAt">;

function emptyReport(sourceId: string, name: string, format: "ui" | "api" | "unknown", revision: Report["revision"]): Report {
  return {
    schemaVersion: 1,
    sourceId,
    name,
    format,
    revision,
    failures: [],
    dropped: [],
    resolved: [],
    unsupported: [],
    missingNodeClasses: [],
    candidateSources: [],
    slots: [],
    needsMaintainer: [],
    converterWarnings: [],
  };
}

/** The pack a node names in its properties (`cnr_id` or `aux_id`), when it names one. */
function packOf(node: UiNodeScan): string | undefined {
  const p = node.properties ?? {};
  for (const key of ["cnr_id", "aux_id"]) {
    const v = p[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Walk a UI workflow's nodes, top level and the subgraphs it instantiates, and sort each
 * into the report: notes dropped, muted and bypassed nodes dropped as ComfyUI's queue
 * drops them, wiring virtuals resolved, classes the target lacks, and anything else as an
 * unsupported construct. Collects the model lists of the nodes as candidate sources.
 */
function scanUi(ui: z.infer<typeof UiScan>, objectInfo: ObjectInfo, report: Report): void {
  const defs = new Map<string, unknown[]>();
  for (const [i, raw] of (ui.definitions?.subgraphs ?? []).entries()) {
    const sg = SubgraphScan.safeParse(raw);
    if (!sg.success) {
      report.unsupported.push({ nodeId: `definition ${i}`, type: "subgraph", construct: "malformed_node", detail: "a subgraph definition without an id and nodes" });
      continue;
    }
    defs.set(sg.data.id, sg.data.nodes);
  }

  const reached = new Set<string>();
  const visit = (nodes: readonly unknown[], subgraph: string | undefined) => {
    nodes.forEach((raw, index) => {
      const parsed = UiNodeScan.safeParse(raw);
      const where = subgraph ? { subgraph } : {};
      if (!parsed.success) {
        report.unsupported.push({ nodeId: `index ${index}`, ...where, type: "unknown", construct: "malformed_node", detail: "a node without an id and a type" });
        return;
      }
      const node = parsed.data;
      const nodeId = String(node.id);
      const mode = node.mode ?? 0;
      collectModels(node, nodeId, report);
      if (FRONTEND_NOTE_NODE_TYPES.has(node.type)) {
        report.dropped.push({ nodeId, ...where, type: node.type, reason: "note" });
        return;
      }
      if (mode === 2 || mode === 4) {
        report.dropped.push({ nodeId, ...where, type: node.type, reason: mode === 2 ? "muted" : "bypassed" });
        return;
      }
      if (mode !== 0) {
        report.unsupported.push({ nodeId, ...where, type: node.type, construct: "unknown_mode", detail: `mode ${mode} is neither always (0), muted (2) nor bypassed (4)` });
        return;
      }
      if (defs.has(node.type)) {
        if (!reached.has(node.type)) {
          reached.add(node.type);
          visit(defs.get(node.type) ?? [], node.type);
        }
        return;
      }
      if (RESOLVED_VIRTUAL_NODE_TYPES.has(node.type)) {
        report.resolved.push({ nodeId, ...where, type: node.type });
        return;
      }
      if (Object.hasOwn(objectInfo, node.type)) return;
      if (UUID.test(node.type)) {
        report.unsupported.push({ nodeId, ...where, type: node.type, construct: "unknown_subgraph", detail: "instantiates a subgraph the workflow doesn't define" });
        return;
      }
      const pack = packOf(node);
      if (pack !== undefined) {
        report.missingNodeClasses.push({ nodeId, ...where, classType: node.type, pack });
        return;
      }
      // No pack named and no schema: a frontend-only node or a class from an unnamed pack.
      // The converter would drop it, so the import fails rather than lose it (spec §8.4).
      report.unsupported.push({ nodeId, ...where, type: node.type, construct: "unknown_virtual_node", detail: "not in the target's object_info, names no node pack, and isn't a virtual node Architect knows" });
    });
  };
  visit(ui.nodes, undefined);
  for (const id of defs.keys()) {
    if (!reached.has(id)) report.dropped.push({ nodeId: id, type: "subgraph", reason: "unused_subgraph" });
  }
  for (const [i, raw] of (ui.models ?? []).entries()) addModelEntry(raw, `workflow models[${i}]`, undefined, report);
}

function addModelEntry(raw: unknown, where: string, nodeId: string | undefined, report: Report): void {
  const m = ModelEntry.safeParse(raw);
  if (!m.success) {
    report.needsMaintainer.push(`${where}: a model entry without a name; not read`);
    return;
  }
  const dup = report.candidateSources.some((c) => c.name === m.data.name && c.directory === m.data.directory && c.url === m.data.url);
  if (dup) return;
  report.candidateSources.push({
    name: m.data.name,
    ...(m.data.directory ? { directory: m.data.directory } : {}),
    ...(m.data.url ? { url: m.data.url } : {}),
    ...(nodeId ? { nodeId } : {}),
  });
}

function collectModels(node: UiNodeScan, nodeId: string, report: Report): void {
  const models = node.properties?.models;
  if (models === undefined) return;
  if (!Array.isArray(models)) {
    report.needsMaintainer.push(`node ${nodeId} (${node.type}): properties.models isn't a list; not read`);
    return;
  }
  for (const m of models) addModelEntry(m, `node ${nodeId} (${node.type})`, nodeId, report);
}

/** A slot id from an input name: lower case, letters, digits and underscores, unique. */
function slotId(base: string, taken: Set<string>): string {
  let id = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(id)) id = `s_${id}`;
  let out = id;
  for (let n = 2; taken.has(out); n++) out = `${id}_${n}`;
  taken.add(out);
  return out;
}

function byNodeId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
}

function inputSpec(objectInfo: ObjectInfo, classType: string, input: string) {
  const def = objectInfo[classType];
  return def?.input.required?.[input] ?? def?.input.optional?.[input];
}

function isCombo(spec: ReturnType<typeof inputSpec>): boolean {
  return spec !== undefined && (Array.isArray(spec[0]) || spec[0] === "COMBO");
}

/**
 * Turn the executable graph into a draft recipe's slots and outputs, by the unambiguous
 * rules of ARCH 2026-11-16 (template import); everything else stays a literal, and what a
 * maintainer has to decide goes into the report.
 */
function annotate(graph: ApiGraph, objectInfo: ObjectInfo, report: Report, slug: string) {
  const slots: RecipeSlot[] = [];
  const taken = new Set<string>();
  const ids = Object.keys(graph).sort(byNodeId);

  // Model files: an input whose value the template's model list names in one folder.
  const folders = new Map<string, Set<string>>();
  for (const c of report.candidateSources) {
    if (!c.directory) continue;
    const set = folders.get(c.name) ?? new Set<string>();
    set.add(c.directory);
    folders.set(c.name, set);
  }
  for (const id of ids) {
    const node = graph[id];
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || value.length === 0) continue;
      const spec = inputSpec(objectInfo, node.class_type, input);
      const dirs = folders.get(value);
      if (dirs && isCombo(spec)) {
        const [folder] = [...dirs];
        if (dirs.size > 1) {
          report.needsMaintainer.push(`node ${id} (${node.class_type}).${input}: ${value} is listed in more than one folder (${[...dirs].join(", ")}); left as a literal`);
        } else if (!MODEL_FOLDER.test(folder)) {
          report.needsMaintainer.push(`node ${id} (${node.class_type}).${input}: folder ${JSON.stringify(folder)} isn't a model folder name; left as a literal`);
        } else {
          slots.push({ id: slotId(input, taken), label: `${node.class_type} ${input}`, valueType: "model_file", target: { node: id, input }, required: true, default: value, modelFolder: folder });
        }
      } else if (isCombo(spec) && looksLikeModelFile(value)) {
        report.needsMaintainer.push(`node ${id} (${node.class_type}).${input}: ${value} isn't in the template's model list, so its folder is unknown; left as a literal`);
      }
    }
  }

  // The prompt: the one CLIPTextEncode with literal text that feeds no `negative` input,
  // preferring the one that feeds a `positive` input when there are several.
  const consumers = new Map<string, { node: string; input: string }[]>();
  for (const id of ids) {
    for (const [input, value] of Object.entries(graph[id].inputs)) {
      if (Array.isArray(value)) {
        const list = consumers.get(value[0]) ?? [];
        list.push({ node: id, input });
        consumers.set(value[0], list);
      }
    }
  }
  const encoders = ids.filter((id) => graph[id].class_type === "CLIPTextEncode");
  const candidates = encoders.filter((id) => typeof graph[id].inputs.text === "string" && !(consumers.get(id) ?? []).some((c) => c.input === "negative"));
  const positive = candidates.filter((id) => (consumers.get(id) ?? []).some((c) => c.input === "positive"));
  const prompt = positive.length === 1 ? positive[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (prompt !== undefined) {
    graph[prompt].inputs.text = "";
    slots.push({ id: slotId("prompt", taken), label: "Prompt", valueType: "string", target: { node: prompt, input: "text" }, required: true, fromTask: "intent" });
  }
  for (const id of encoders) {
    if (id === prompt) continue;
    report.needsMaintainer.push(
      prompt === undefined
        ? `node ${id} (CLIPTextEncode): which text encoder takes the task's prompt isn't clear; its text is blanked`
        : `node ${id} (CLIPTextEncode): not the prompt slot; its text (a negative or second prompt) is blanked`,
    );
  }

  // Input images: LoadImage's file, from the task's inputs in node order.
  const loaders = ids.filter((id) => graph[id].class_type === "LoadImage" && typeof graph[id].inputs.image === "string");
  loaders.forEach((id, n) => {
    graph[id].inputs.image = "";
    const fromTask = n === 0 ? "inputs.source_image" : `inputs.reference_image.${n}`;
    slots.push({ id: slotId(n === 0 ? "source_image" : `reference_image_${n}`, taken), label: `LoadImage image (${fromTask})`, valueType: "input_image", target: { node: id, input: "image" }, required: true, fromTask });
  });
  if (loaders.length > 1) {
    report.needsMaintainer.push(`${loaders.length} LoadImage nodes: the first by node id (${loaders[0]}) takes the source image, the others reference images; check the roles`);
  }
  for (const id of ids) {
    const node = graph[id];
    if (node.class_type === "LoadImage") continue;
    for (const input of Object.keys(node.inputs)) {
      const options = inputSpec(objectInfo, node.class_type, input)?.[1];
      if (options && options.image_upload === true) {
        report.needsMaintainer.push(`node ${id} (${node.class_type}).${input}: loads a file from the input folder; not bound to the task`);
      }
    }
  }

  // Outputs: SaveImage nodes, writing under architect/ rather than the template's prefix.
  const outputs: Recipe["outputs"] = [];
  for (const id of ids) {
    const node = graph[id];
    if (node.class_type === "SaveImage") {
      node.inputs.filename_prefix = `architect/imported-${slug}`;
      outputs.push({ role: outputs.length === 0 ? "image" : `image_${outputs.length + 1}`, node: id, format: "png" });
    } else if (objectInfo[node.class_type]?.output_node === true) {
      report.needsMaintainer.push(`node ${id} (${node.class_type}): an output node other than SaveImage; not recorded as an output`);
    }
  }

  // Template text is data (SEC T2): every free-text widget is blanked, the negative prompt
  // and any other text encoder's as well as the prompt slot's, so no sentence of the template
  // reaches the draft or a render; a maintainer writes what a widget should hold. COMBO
  // values (sampler names, model files) are choices the target lists, not free text, and the
  // output prefix was set above.
  const slotted = new Set(slots.map((x) => `${x.target.node}\u0000${x.target.input}`));
  for (const id of ids) {
    const node = graph[id];
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || value.length === 0 || slotted.has(`${id}\u0000${input}`)) continue;
      if (node.class_type === "SaveImage" && input === "filename_prefix") continue;
      const spec = inputSpec(objectInfo, node.class_type, input);
      if (isCombo(spec)) continue;
      node.inputs[input] = "";
      if (node.class_type !== "CLIPTextEncode") {
        report.needsMaintainer.push(`node ${id} (${node.class_type}).${input}: a text widget; its template text is blanked`);
      }
    }
  }

  // The output size isn't bound: which node sets it isn't something the import decides.
  for (const id of ids) {
    const node = graph[id];
    if (typeof node.inputs.width === "number" && typeof node.inputs.height === "number" && /Latent/.test(node.class_type)) {
      report.needsMaintainer.push(`node ${id} (${node.class_type}): writes ${node.inputs.width}x${node.inputs.height}; the size isn't bound to the task`);
    }
  }

  report.slots = slots.map((s) => ({ id: s.id, valueType: s.valueType, node: s.target.node, input: s.target.input }));
  return { slots, outputs };
}

/** Required inputs a converted node lacks: a link or widget the conversion lost. */
function missingRequired(graph: ApiGraph, objectInfo: ObjectInfo): string[] {
  const out: string[] = [];
  for (const id of Object.keys(graph).sort(byNodeId)) {
    const node = graph[id];
    for (const name of Object.keys(objectInfo[node.class_type]?.input.required ?? {})) {
      if (!Object.hasOwn(node.inputs, name)) out.push(`node ${id} (${node.class_type}) lacks its required input ${name} after conversion`);
    }
  }
  return out;
}

/** The workflow of a template and what the source says about it. */
interface ReadTemplate {
  text: string;
  entry: TemplateListEntry;
  date?: string;
  /** Where the content came from, as the recipe's evidence cites it. */
  cite: string;
  evidenceKind: "documentation" | "upstream_pack";
  /** A pack's manifest models, or why they are unknown; absent for an index template. */
  packModels?: { models: { name: string; directory: string; url: string }[]; unnamed: number } | { unknown: string };
}

async function readTemplate(deps: TemplateDeps, source: SourceRegistryEntry, name: string): Promise<ReadTemplate> {
  let listed: IndexedTemplate[];
  try {
    listed = (source.adapter === "comfyui_template_index" ? await readIndex(deps, source) : await readPacks(deps, source)).templates;
    deps.store.recordSourceRefresh({ id: source.id, at: deps.now(), outcome: { ok: true } });
  } catch (err) {
    const reason = message(err);
    deps.store.recordSourceRefresh({ id: source.id, at: deps.now(), outcome: { ok: false, reason } });
    throw new TemplateSourceError("SOURCE_UNAVAILABLE", `source ${source.id} is unavailable: ${reason}`);
  }
  const found = listed.find((t) => t.entry.name === name);
  if (!found) throw new TemplateSourceError("NOT_LISTED", `source ${source.id} lists no template ${name}`);
  if (!found.entry.importable) throw new TemplateSourceError("NOT_LISTED", `source ${source.id} lists ${name}, but has no workflow for it`);

  if (source.adapter === "comfyui_template_index") {
    // Next to the index at the registered root; the name is one checked path segment.
    const url = new URL(`${encodeURIComponent(name)}.json`, source.root).toString();
    try {
      const text = await fetchText(deps, url, MAX_WORKFLOW_BYTES, `template ${name}`);
      return { text, entry: found.entry, ...(found.date ? { date: found.date } : {}), cite: `GET ${url}`, evidenceKind: "documentation" };
    } catch (err) {
      throw new TemplateSourceError("UNREADABLE", `template ${name} couldn't be read: ${message(err)}`);
    }
  }

  const root = requirePacksRoot(source);
  const file = deps.upstream.packWorkflowFile(name);
  if (file === undefined) throw new TemplateSourceError("UNREADABLE", `pack ${name} has no workflow file`);
  const real = realpathSync(file);
  // Upstream resolves its own packs folder; the import reads only inside the registered one.
  if (!real.startsWith(root + sep)) throw new TemplateSourceError("UNREADABLE", `pack ${name}'s workflow isn't under ${source.root}`);
  if (statSync(real).size > MAX_WORKFLOW_BYTES) throw new TemplateSourceError("UNREADABLE", `pack ${name}'s workflow is larger than ${MAX_WORKFLOW_BYTES} bytes`);
  const text = readFileSync(real, "utf-8");
  let packModels: ReadTemplate["packModels"];
  try {
    const listedModels = await deps.upstream.packManifestModels(name);
    if (listedModels === undefined) {
      packModels = { unknown: "the pack has no manifest, so its model list is unknown" };
    } else {
      const models = listedModels.flatMap((m) => {
        const named = packModelFiles([m]).files[0];
        return named ? [{ ...named, url: m.url }] : [];
      });
      packModels = { models, unnamed: listedModels.length - models.length };
    }
  } catch (err) {
    packModels = { unknown: `the pack's manifest couldn't be read (${message(err)}), so its model list is unknown` };
  }
  return { text, entry: found.entry, cite: `packs/${name}/${basename(real)}`, evidenceKind: "upstream_pack", packModels };
}

/**
 * Import one template of a registered source as a draft recipe (spec §8.4; ARCH
 * 2026-11-16, template import). Reads the workflow from that source only, converts a UI
 * workflow with upstream's converter against the target's object_info, and returns the
 * draft with its conversion report, or the report alone when the import fails. Throws
 * `TemplateSourceError` before any content is read: unknown source, operation not allowed,
 * source unavailable, name not listed, node schemas unreadable.
 */
export async function importTemplate(deps: TemplateDeps, sourceId: string, name: string): Promise<TemplateImport> {
  const source = requireSource(deps, sourceId, "import");
  const checked = TemplateName.safeParse(name);
  if (!checked.success) throw new TemplateSourceError("INVALID_NAME", `${JSON.stringify(name)}: ${checked.error.issues[0]?.message ?? "invalid name"}`);
  let objectInfo: ObjectInfo;
  try {
    objectInfo = await deps.upstream.objectInfo();
  } catch (err) {
    throw new TemplateSourceError("SCHEMAS_UNAVAILABLE", `the target's node schemas couldn't be read: ${message(err)}`);
  }
  const read = await readTemplate(deps, source, name);
  const importedAt = deps.now().toISOString();
  const revision = { contentSha256: sha256Hex(read.text), ...(read.date ? { indexDate: read.date } : {}) };

  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    const report = emptyReport(source.id, name, "unknown", revision);
    report.failures.push("the workflow isn't JSON");
    return failed(report, importedAt);
  }
  const format = isUiWorkflow(raw) ? "ui" : "api";
  const report = emptyReport(source.id, name, format, revision);
  if (format === "api" && !isApiWorkflow(raw)) {
    report.failures.push("the workflow is neither in the UI format (nodes and links) nor in the API format (nodes with a class_type)");
    return failed(report, importedAt);
  }

  let graph: ApiGraph | undefined;
  if (format === "ui") {
    const scan = UiScan.safeParse(raw);
    if (!scan.success) {
      report.failures.push("the UI workflow's nodes or definitions don't have the expected shape");
      return failed(report, importedAt);
    }
    scanUi(scan.data, objectInfo, report);
    if (report.unsupported.length > 0 || report.missingNodeClasses.length > 0) {
      report.failures.push(...report.unsupported.map((u) => `unsupported ${u.construct}: node ${u.nodeId}${u.subgraph ? ` in subgraph ${u.subgraph}` : ""} (${u.type}): ${u.detail}`));
      report.failures.push(...report.missingNodeClasses.map((m) => `node ${m.nodeId}${m.subgraph ? ` in subgraph ${m.subgraph}` : ""}: class ${m.classType}${m.pack ? ` (pack ${m.pack})` : ""} isn't on the target`));
      return failed(report, importedAt);
    }
    let converted;
    try {
      converted = uiToApi(raw, objectInfo);
    } catch (err) {
      report.failures.push(`upstream's converter failed: ${message(err)}`);
      return failed(report, importedAt);
    }
    report.converterWarnings.push(...converted.warnings);
    // The scan above covers every node it can see; this catches one the converter found
    // after expansion that the scan didn't.
    for (const m of converted.missingNodeTypes) {
      report.missingNodeClasses.push({ nodeId: m.nodeId, classType: m.classType });
      report.failures.push(`node ${m.nodeId} (after subgraph expansion): class ${m.classType} isn't on the target`);
    }
    const parsed = ApiGraph.safeParse(converted.graph);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      report.failures.push(`the converted graph holds a value a recipe can't (${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"})`);
    } else {
      graph = parsed.data;
    }
  } else {
    const parsed = ApiGraph.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      report.failures.push(`the API graph holds a value a recipe can't (${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"})`);
    } else {
      graph = parsed.data;
      for (const id of Object.keys(graph).sort(byNodeId)) {
        const classType = graph[id].class_type;
        if (!Object.hasOwn(objectInfo, classType)) {
          report.missingNodeClasses.push({ nodeId: id, classType });
          report.failures.push(`node ${id}: class ${classType} isn't on the target`);
        }
      }
    }
  }
  if (read.packModels && "unknown" in read.packModels) {
    report.needsMaintainer.push(read.packModels.unknown);
  } else if (read.packModels) {
    for (const m of read.packModels.models) addModelEntry({ name: m.name, directory: m.directory, url: m.url }, "the pack manifest", undefined, report);
    if (read.packModels.unnamed > 0) report.needsMaintainer.push(`the pack manifest names no folder for ${read.packModels.unnamed} model URL(s); not read`);
  }
  if (!graph || report.failures.length > 0) return failed(report, importedAt);

  report.failures.push(...missingRequired(graph, objectInfo));
  if (Object.keys(graph).length === 0) report.failures.push("the executable graph is empty");
  if (report.converterWarnings.length > 0) {
    report.needsMaintainer.push(`upstream's converter wrote ${report.converterWarnings.length} warning(s); review converterWarnings`);
  }

  // Each graph value is the template's literal; _meta carries its node titles, which are
  // template text and execute nothing, so the draft drops them.
  for (const node of Object.values(graph)) delete node._meta;
  const slug = name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  const { slots, outputs } = annotate(graph, objectInfo, report, slug);
  if (outputs.length === 0) report.failures.push("the graph has no SaveImage node, so the recipe would have no output");
  if (read.entry.kind !== "image") report.failures.push(`the source names no image kind for ${name}${read.entry.kind ? ` (it is ${read.entry.kind})` : ""}; only image templates import`);
  if (read.entry.operations.length === 0) report.failures.push(`no image operation can be read from ${name}'s tags or pack kind (${read.entry.tags.join(", ") || "none"}); a maintainer names it`);
  if (slug.length === 0) report.failures.push(`${name} gives no recipe id`);
  if (report.failures.length > 0) return failed(report, importedAt);

  const recipeId = `recipe-imported.${slug}`;
  const draft = Recipe.safeParse({
    schemaVersion: 1,
    id: recipeId,
    revision: 1,
    title: `${name} (imported from ${source.id})`,
    description: `Draft imported from the ${source.id} template ${name}, content sha256 ${revision.contentSha256}. Not reviewed: see the conversion report for what needs a maintainer.`,
    kind: "image",
    operations: read.entry.operations,
    graph,
    slots,
    outputs,
    dependencies: { nodeClasses: [...new Set(Object.values(graph).map((n) => n.class_type))].sort() },
    certification: "proposed",
    evidence: [
      {
        kind: read.evidenceKind,
        source: `${read.cite} (sha256 ${revision.contentSha256})`,
        observedAt: importedAt,
        note: "Imported by Architect's template import: subgraphs flattened and the UI graph converted by upstream's convertUiToApi against the target's object_info. Not reviewed (spec §8.4).",
      },
    ],
  });
  if (!draft.success) {
    report.failures.push(...draft.error.issues.map((i) => `the draft isn't a valid recipe: ${i.path.join(".")}: ${i.message}`));
    return failed(report, importedAt);
  }
  return { ok: true, recipe: draft.data, report: TemplateConversionReport.parse({ ...report, importedAt, outcome: "draft", recipeId }) };
}

function failed(report: Report, importedAt: string): TemplateImport {
  return { ok: false, report: TemplateConversionReport.parse({ ...report, importedAt, outcome: "failed" }) };
}
