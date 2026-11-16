#!/usr/bin/env node
// ComfyUI Architect stdio smoke (TODO 1.10, 1.1.3): start the built server the way an
// external MCP client does, read the handshake, list the tools, and with the flag on call
// architect_inspect against the configured ComfyUI. Upstream's smoke-install checks the
// packed tarball; this checks what an MCP client sees, with the Architect flag off and on.
//
// Usage: node scripts/architect/stdio-smoke.mjs [off|on|both] [--offline] [--plan] [--run] [--acquire]
//        node scripts/architect/stdio-smoke.mjs [on] --recipes <id,id,...|all> [--dry] [--upload-mask] [--downloads]
//   both (default)  runs off, then on, and checks that on adds exactly the architect_* tools
//   --offline       accepts the STALE_ENVIRONMENT error when no ComfyUI answers, so the
//                   wiring can be checked without a running ComfyUI
//   --plan          with the flag on, also plans a 1024x1024 text-to-image task through
//                   architect_plan (prepare, propose, select, export) into a temporary
//                   ARCHITECT_DATA_DIR; needs a feasible candidate on the target
//   --run           implies --plan, then renders the selected candidate through architect_run
//                   (prepare, start, status until it settles, finalize). It RENDERS on the
//                   target. The approval stands in for the user: the script runs the terminal
//                   command's code with the typed hash, since a smoke has no person at a TTY
//   --acquire       implies --run with a 2048x2048 task and the candidate of recipe
//                   recipe-zimage-turbo.t2i-upscale2x (TODO 4.7). When that candidate is
//                   acquirable, the run DOWNLOADS its missing pinned file (RealESRGAN x4plus,
//                   about 64 MiB) from Hugging Face INTO THE TARGET'S MODEL FOLDER, then renders;
//                   the checks cover the acquire effect, the refused unapproved start, the
//                   placed file and its sha256 in the run's dependency lock. When the file is
//                   already installed, the candidate is feasible and the script runs it as --run
//   --recipes       with the flag on, for each named shipped recipe (or all): prepares a task that
//                   fits its operation and size rule (input images blue_poppies_field.png,
//                   egyptian_queen.png and medusa_poster.png from the target's input folder, whose
//                   sizes it reads there), proposes, selects that recipe's candidate, prepares the
//                   run and prints the action plan's effects; then approves it through the terminal
//                   channel's code, RENDERS it on the target, checks the outputs and prints one
//                   summary line per recipe. An acquirable candidate is only run with --downloads
//   --dry           with --recipes: stops after the run's prepare for every recipe and prints the
//                   download list (folder/file, repo@commit, size, licence) and its total. Nothing
//                   is downloaded, rendered or uploaded; inpaint recipes plan with medusa_poster.png
//                   standing in for the mask when the smoke mask isn't in the input folder
//   --upload-mask   with --recipes: before the session, UPLOADS architect-smoke-mask.png (1024x1024,
//                   a white rectangle in the centre on black) into the target's input folder with
//                   upstream's client; without it (and outside --dry) inpaint recipes are skipped
//   --downloads     with --recipes: approve action plans that DOWNLOAD the candidate's pinned files
//                   INTO THE TARGET'S MODEL FOLDERS before rendering
// The target comes from the usual environment (COMFYUI_URL, COMFYUI_HOST/PORT, ...).
// Needs `npm run build` first. Exits 1 if any check fails.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const args = process.argv.slice(2);
const recipesAt = args.indexOf("--recipes");
const recipesArg = recipesAt >= 0 ? args[recipesAt + 1] : undefined;
if (recipesAt >= 0 && (recipesArg === undefined || recipesArg.startsWith("--"))) {
  console.error("--recipes needs a comma-separated list of recipe ids, or all");
  process.exit(2);
}
const dry = args.includes("--dry");
const uploadMask = args.includes("--upload-mask");
const allowDownloads = args.includes("--downloads");
if ((dry || uploadMask || allowDownloads) && recipesArg === undefined) {
  console.error("--dry, --upload-mask and --downloads go with --recipes");
  process.exit(2);
}
if (dry && (uploadMask || allowDownloads)) {
  console.error("--dry uploads and downloads nothing; leave out --upload-mask and --downloads");
  process.exit(2);
}
const offline = args.includes("--offline");
const acquire = args.includes("--acquire");
const run = args.includes("--run") || acquire;
const ACQUIRE_RECIPE = "recipe-zimage-turbo.t2i-upscale2x";
const side = acquire ? 2048 : 1024;
const plan = args.includes("--plan") || run;
const dataDir = mkdtempSync(join(tmpdir(), "architect-smoke-"));
const mode = args.find((a, i) => !a.startsWith("--") && i !== recipesAt + 1) ?? (recipesArg !== undefined ? "on" : "both");
if (!["off", "on", "both"].includes(mode)) {
  console.error(`unknown mode "${mode}"; use off, on or both`);
  process.exit(2);
}
if (!existsSync(ENTRY)) {
  console.error(`${ENTRY} is missing; run npm run build first`);
  process.exit(2);
}

const failures = [];
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

async function session(flagOn) {
  const env = { ...process.env };
  if (flagOn) env.COMFYUI_ARCHITECT = "1";
  else delete env.COMFYUI_ARCHITECT;
  env.ARCHITECT_DATA_DIR = dataDir;
  // --full lists every tool directly; compact mode would hide them behind call_tool.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "--full"],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "architect-stdio-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    const forkLine = (client.getInstructions() ?? "").split("\n").find((l) => l.startsWith("Fork: ")) ?? "";
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const label = flagOn ? "[on] " : "[off]";
    console.log(`${label} ${info?.title ?? info?.name} ${info?.version}; ${tools.length} tools`);
    check(info?.title?.startsWith("ComfyUI Architect") === true, `${label} serverInfo.title names the fork`);
    check(forkLine.includes(flagOn ? "Architect tools on" : "Architect tools off"), `${label} handshake line: ${forkLine || "missing"}`);
    const architect = tools.filter((n) => n.startsWith("architect_"));
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    if (!flagOn) {
      check(architect.length === 0, `${label} no architect_* tools`);
      check(prompts.length === 0, `${label} prompt list empty, as upstream's (${prompts.join(", ") || "none"})`);
      return { tools };
    }
    check(architect.includes("architect_inspect"), `${label} architect_inspect listed`);
    check(prompts.includes("architect") && prompts.includes("architect_skill"), `${label} prompts: ${prompts.join(", ") || "none"}`);
    const res = await client.callTool({ name: "architect_inspect", arguments: { action: "environment" } }, undefined, CALL_TIMEOUT);
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      check(false, `${label} architect_inspect returns a JSON envelope`);
      return { tools };
    }
    console.log(`${label} architect_inspect: ${envelope.status}: ${envelope.summary}`);
    const reachable = envelope.status === "ok" || envelope.status === "partial";
    const acceptedOffline = offline && envelope.error?.code === "STALE_ENVIRONMENT";
    check(reachable || acceptedOffline, `${label} architect_inspect status ${envelope.status}${acceptedOffline ? " (offline accepted)" : ""}`);
    for (const w of envelope.warnings ?? []) console.log(`      warning: ${w}`);
    if (plan) await planTask(client, label);
    if (recipesArg !== undefined) await recipeRuns(client, label);
    return { tools };
  } finally {
    await client.close();
  }
}

// The SDK's default request timeout is 60 s. On a slow target (upstream's live-server
// probes can take many seconds each) a call may need longer; the smoke waits up to 10 min.
const CALL_TIMEOUT = { timeout: 600_000 };

async function callPlan(client, args) {
  const res = await client.callTool({ name: "architect_plan", arguments: args }, undefined, CALL_TIMEOUT);
  return JSON.parse(res.content?.[0]?.type === "text" ? res.content[0].text : "{}");
}

async function planTask(client, label) {
  const task = {
    intent: "A red bicycle leaning against a white wall, soft morning light.",
    media: { kind: "image", operation: "text_to_image", output: { width: side, height: side } },
  };
  const prepared = await callPlan(client, { action: "prepare", task });
  console.log(`${label} prepare: ${prepared.status}: ${prepared.summary}`);
  check(prepared.status !== "error", `${label} prepare stored the task`);
  const planId = prepared.data?.plan?.id;
  if (!planId) return;
  const proposed = await callPlan(client, { action: "propose", planId });
  console.log(`${label} propose: ${proposed.status}: ${proposed.summary}`);
  for (const c of proposed.data?.candidates ?? []) {
    console.log(`      ${c.status.padEnd(10)} ${c.recipe} ${JSON.stringify(c.bindings)}`);
    for (const b of c.blocking) console.log(`        blocking: ${b}`);
  }
  const candidates = proposed.data?.candidates ?? [];
  let best;
  let acquiring = false;
  if (acquire) {
    best = candidates.find((c) => c.recipe.startsWith(`${ACQUIRE_RECIPE} r`));
    check(best !== undefined, `${label} a candidate of ${ACQUIRE_RECIPE}`);
    if (!best) return;
    if (best.status === "feasible") {
      console.log(`${label} ${ACQUIRE_RECIPE} is already feasible (its files are installed, perhaps by an earlier run); running it as --run does`);
    } else {
      check(best.status === "acquirable", `${label} ${ACQUIRE_RECIPE} is acquirable: ${best.status}`);
      if (best.status !== "acquirable") return;
      acquiring = true;
      for (const f of best.acquisition?.files ?? []) console.log(`      to acquire: ${f.folder}/${f.file} ${f.size} from ${f.source}`);
    }
  } else {
    best = candidates.find((c) => c.status === "feasible");
    check(best !== undefined, `${label} a feasible candidate`);
    if (!best) return;
  }
  const selected = await callPlan(client, { action: "select", planId, candidateId: best.id });
  check(selected.status === "ok", `${label} select: ${selected.summary}`);
  const exported = await callPlan(client, { action: "export", planId });
  check(exported.status === "ok" && exported.artifacts?.length === 6, `${label} export: ${exported.summary}`);
  if (run) {
    // A thrown call (a timeout, a closed connection) is reported as a failed check, with the
    // run id when there is one, so the run can be followed or cancelled by hand.
    const progress = { runId: undefined };
    try {
      await runTask(client, label, planId, acquiring, progress);
    } catch (err) {
      check(false, `${label} run steps threw: ${err instanceof Error ? err.message : String(err)}${progress.runId ? `; run ${progress.runId}` : "; no run was created"}`);
    }
  }
}

async function callRun(client, args) {
  const res = await client.callTool({ name: "architect_run", arguments: args }, undefined, CALL_TIMEOUT);
  return JSON.parse(res.content?.[0]?.type === "text" ? res.content[0].text : "{}");
}

async function runTask(client, label, planId, acquiring, progress) {
  const prepared = await callRun(client, { action: "prepare", planId });
  console.log(`${label} run prepare: ${prepared.status}: ${prepared.summary}`);
  const actionPlanId = prepared.data?.actionPlan?.id;
  const requestId = prepared.data?.approvalRequest?.id;
  if (!actionPlanId || !requestId) return check(false, `${label} run prepare returned an action plan${prepared.error ? `: ${prepared.error.code}: ${prepared.summary}` : ""}`);
  const effects = prepared.data.actionPlan.effects ?? [];
  const acquireEffect = effects.find((e) => e.kind === "acquire_models");
  if (acquiring) {
    check(effects[0]?.kind === "acquire_models", `${label} the action plan downloads first: ${effects.map((e) => e.kind).join(", ")}`);
    for (const f of acquireEffect?.files ?? []) {
      console.log(`      download: ${f.destinationRoot}/${f.folder}/${f.file} from ${f.source.repo}@${f.source.revision.slice(0, 12)} (${f.source.sizeBytes} bytes)`);
    }
  } else {
    check(acquireEffect === undefined, `${label} a feasible candidate's action plan downloads nothing`);
  }
  const refused = await callRun(client, { action: "start", actionPlanId });
  check(refused.error?.code === "APPROVAL_REQUIRED", `${label} start without approval is refused: ${refused.error?.code}`);
  if (acquiring) {
    const nothing = (acquireEffect?.files ?? []).every((f) => !existsSync(join(f.destinationRoot, f.folder, f.file)));
    check(nothing, `${label} nothing was downloaded before the approval`);
  }
  // The stand-in for the user: the terminal command's code, with the hash the plan shows.
  const { runArchitectCli } = await import("../../dist/services/architect/cli.js");
  const { ArchitectStore } = await import("../../dist/services/architect/store.js");
  const store = ArchitectStore.open(dataDir);
  const out = [];
  const code = await runArchitectCli(["approve", requestId], {
    store,
    io: { interactive: true, write: (t) => out.push(t), ask: async () => prepared.data.shortHash },
  });
  store.close();
  check(code === 0, `${label} approved in the terminal channel (${prepared.data.shortHash})`);
  const started = await callRun(client, { action: "start", actionPlanId });
  console.log(`${label} run start: ${started.status}: ${started.summary}`);
  const runId = started.data?.run?.id;
  if (!runId) return check(false, `${label} start created a run`);
  progress.runId = runId;
  console.log(`${label} run id: ${runId}`);
  const again = await callRun(client, { action: "start", actionPlanId });
  check(again.data?.run?.id === runId && again.data?.resumed === true, `${label} a second start returns the same run`);
  let status;
  let lastProgress = "";
  // A render on the reference target has taken from 85 s to almost 6 min for the same graph,
  // depending on what ComfyUI held in memory; the limit leaves room for that.
  const deadline = Date.now() + 20 * 60 * 1000;
  do {
    await new Promise((r) => setTimeout(r, 2000));
    status = await callRun(client, { action: "status", runId });
    const progress = (status.data?.acquisitions ?? []).map((a) => `${a.file} ${a.state}${a.bytesSoFar !== undefined ? ` ${a.bytesSoFar}/${a.sizeBytes}` : ""}`).join(", ");
    if (progress && progress !== lastProgress) console.log(`      ${status.data?.run?.state}: ${progress}`);
    lastProgress = progress;
  } while (!["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"].includes(status.data?.run?.state) && Date.now() < deadline);
  const r = status.data?.run;
  console.log(`${label} run status: ${status.summary}`);
  for (const e of status.data?.evaluations ?? []) console.log(`      ${e.criterion.padEnd(18)} ${e.verdict.padEnd(8)} ${e.explanation}`);
  check(r?.state === "COMPLETED" || r?.state === "AWAITING_REVIEW", `${label} run finished: ${r?.state}${r?.error ? ` (${r.error.code}: ${r.error.message})` : ""}`);
  check((r?.outputs?.length ?? 0) > 0, `${label} run outputs: ${(r?.outputs ?? []).map((o) => `${o.subfolder}/${o.filename}`).join(", ")}`);
  check(status.data?.verdicts?.execution === "passed", `${label} verdicts: ${JSON.stringify(status.data?.verdicts)}`);
  if (acquire) {
    const dims = (status.data?.evaluations ?? []).find((e) => e.criterion === "output_dimensions");
    check(dims?.verdict === "pass", `${label} output is ${side}x${side}: ${dims?.verdict} (${dims?.explanation ?? "no check"})`);
  }
  const acquisitions = status.data?.acquisitions ?? [];
  if (acquiring) {
    check(acquisitions.length > 0 && acquisitions.every((a) => a.state === "placed"), `${label} every download placed: ${acquisitions.map((a) => `${a.file} ${a.state}`).join(", ")}`);
    for (const a of acquisitions) check(typeof a.placedPath === "string" && existsSync(a.placedPath), `${label} installed: ${a.placedPath}`);
  }
  const finalized = await callRun(client, { action: "finalize", runId });
  const written = (finalized.artifacts ?? []).map((f) => String(f).split("/").pop()).sort();
  check(
    finalized.status === "ok" && JSON.stringify(written) === JSON.stringify(["dependencies.lock.json", "evaluation.json", "run.json"]),
    `${label} finalize: ${finalized.summary}`,
  );
  if (acquiring) {
    const lockFile = (finalized.artifacts ?? []).find((f) => String(f).endsWith("dependencies.lock.json"));
    const lock = lockFile ? JSON.parse(readFileSync(lockFile, "utf-8")) : {};
    for (const f of acquireEffect?.files ?? []) {
      const entry = (lock.acquired ?? []).find((a) => a.folder === f.folder && a.file === f.file);
      check(
        entry?.sha256 === f.source.sha256 && entry?.commit === f.source.revision && entry?.repo === f.source.repo,
        `${label} the lock lists ${f.folder}/${f.file} with commit ${f.source.revision.slice(0, 12)} and sha256 ${entry?.sha256?.slice(0, 12) ?? "missing"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------
// --recipes: one task per shipped recipe (TODO 5.6)

const RECIPES_DIR = fileURLToPath(new URL("../../architect/recipes/", import.meta.url));
const MASK_NAME = "architect-smoke-mask.png";
const INPUT_FILES = { source: "blue_poppies_field.png", wide: "egyptian_queen.png", poster: "medusa_poster.png" };
const INTENTS = {
  text_to_image: "A red bicycle leaning against a white wall, soft morning light.",
  image_edit: "Turn the sky into a dramatic orange sunset.",
  inpaint: "A small wooden rowing boat.",
  reference_guided: "A portrait in the style and composition of the reference, soft window light.",
  upscale: "The same image at a higher resolution.",
};

function shippedRecipes() {
  return readdirSync(RECIPES_DIR)
    .filter((f) => f.endsWith(".recipe.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(RECIPES_DIR, f), "utf-8")));
}

function chosenRecipes() {
  const all = shippedRecipes();
  if (recipesArg === "all") return all;
  const ids = recipesArg.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !all.some((r) => r.id === id));
  if (unknown.length > 0) {
    console.error(`no shipped recipe ${unknown.join(", ")}; shipped: ${all.map((r) => r.id).join(", ")}`);
    process.exit(2);
  }
  return ids.map((id) => all.find((r) => r.id === id));
}

/** A PNG's pixel size from its IHDR chunk, or undefined for anything else. */
function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The size of a file in the target's input folder, read through ComfyUI's /view. */
async function inputSize(baseUrl, name) {
  const res = await fetch(`${baseUrl}/view?type=input&filename=${encodeURIComponent(name)}`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return pngSize(Buffer.from(await res.arrayBuffer())) ?? { error: "not a PNG" };
}

/** A grayscale PNG, white inside the centred half-size rectangle and black outside. */
function maskPng(side = 1024) {
  const row = side + 1;
  const raw = Buffer.alloc(row * side);
  for (let y = side / 4; y < (side * 3) / 4; y++) raw.fill(255, y * row + 1 + side / 4, y * row + 1 + (side * 3) / 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The task inputs a recipe's input_image slots take, and which file stands in for each. */
function inputsFor(recipe, maskName) {
  const out = [];
  for (const s of recipe.slots.filter((x) => x.valueType === "input_image")) {
    if (s.fromTask === "inputs.source_image") {
      // The edit recipes that scale the source to the task's size get the wide image, so the
      // aspect check has something to compare; the others the square one.
      out.push({ role: "source_image", name: recipe.outputs[0].scalesInputToTask && recipe.operations.includes("image_edit") ? INPUT_FILES.wide : INPUT_FILES.source });
    } else if (s.fromTask === "inputs.mask") {
      out.push({ role: "mask", name: maskName });
    } else if (s.fromTask === "inputs.reference_image.1") {
      out.push({ role: "reference_image", name: INPUT_FILES.poster });
    } else if (s.fromTask === "inputs.reference_image.2") {
      out.push({ role: "reference_image", name: INPUT_FILES.wide });
    }
  }
  return out;
}

/** A task size that fits the recipe's size rule for these inputs, or why there is none. */
function sizeFor(recipe, inputs, sizes) {
  const o = recipe.outputs[0];
  const of = (path) => {
    const role = path === "inputs.mask" ? "mask" : path.startsWith("inputs.reference_image") ? "reference_image" : "source_image";
    const n = path.startsWith("inputs.reference_image.") ? Number(path.split(".").pop()) : 1;
    const input = inputs.filter((i) => i.role === role)[n - 1];
    return input ? sizes.get(input.name) : undefined;
  };
  if (o.scaleOfInput) {
    const d = of(o.scaleOfInput.input);
    if (!d || d.error) return { error: `the size of ${o.scaleOfInput.input} wasn't read${d?.error ? `: ${d.error}` : ""}` };
    return { width: d.width * o.scaleOfInput.factor, height: d.height * o.scaleOfInput.factor };
  }
  if (o.scalesInputToTask) {
    // About one megapixel at the input's aspect ratio, sides multiples of 16.
    const d = of(o.scalesInputToTask);
    if (!d || d.error) return { error: `the size of ${o.scalesInputToTask} wasn't read` };
    const scale = Math.sqrt((1024 * 1024) / (d.width * d.height));
    return { width: Math.round((d.width * scale) / 16) * 16, height: Math.round((d.height * scale) / 16) * 16 };
  }
  return { width: 1024, height: 1024 };
}

/** Bindings for the slots neither the task nor a default fills: denoise, as the packs set it. */
function bindingsFor(recipe) {
  const out = {};
  for (const s of recipe.slots) {
    if (!s.required || s.default !== undefined || s.fromTask !== undefined) continue;
    // 0.6: packs/z-image-turbo-img2img's denoise, inside comfyui-core's 0.5 to 0.8.
    if (s.id === "denoise") out[s.id] = 0.6;
  }
  return out;
}

async function recipeRuns(client, label) {
  const recipes = chosenRecipes();
  // The target as upstream resolves it for this environment, the one the server uses.
  const { createUpstreamFacade } = await import("../../dist/services/architect/upstream.js");
  const baseUrl = createUpstreamFacade().comfyuiBaseUrl().replace(/\/$/, "");
  const maskThere = !(await inputSize(baseUrl, MASK_NAME)).error;
  const sizes = new Map();
  for (const name of [...Object.values(INPUT_FILES), ...(maskThere ? [MASK_NAME] : [])]) sizes.set(name, await inputSize(baseUrl, name));
  for (const [name, d] of sizes) console.log(`${label} input ${name}: ${d.error ? `unreadable (${d.error})` : `${d.width}x${d.height}`}`);
  const summary = [];
  const downloads = new Map();
  for (const recipe of recipes) {
    const id = recipe.id;
    const operation = recipe.operations[0];
    const needsMask = recipe.slots.some((s) => s.fromTask === "inputs.mask");
    let maskName = MASK_NAME;
    if (needsMask && !maskThere) {
      if (!dry) {
        summary.push(`${id}: SKIPPED, inpainting needs ${MASK_NAME} in the input folder (--upload-mask)`);
        continue;
      }
      maskName = INPUT_FILES.poster;
      console.log(`${label} ${id}: dry run, ${maskName} stands in for the mask`);
    }
    const inputs = inputsFor(recipe, maskName);
    const size = sizeFor(recipe, inputs, sizes);
    if (size.error) {
      summary.push(`${id}: FAIL, no task size: ${size.error}`);
      failures.push(`${id}: no task size`);
      continue;
    }
    const task = {
      intent: INTENTS[operation] ?? INTENTS.text_to_image,
      media: { kind: recipe.kind, operation, output: { width: size.width, height: size.height } },
      inputs: inputs.map((i) => ({ assetId: `comfyui-input:${i.name}`, role: i.role })),
    };
    console.log(`\n${label} ${id} r${recipe.revision}: ${operation} ${size.width}x${size.height}${inputs.length ? ` from ${inputs.map((i) => `${i.role} ${i.name}`).join(", ")}` : ""}`);
    try {
      summary.push(await recipeRun(client, label, recipe, task, downloads));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.push(`${id}: FAIL, ${message}`);
      failures.push(`${id}: ${message}`);
    }
  }
  if (dry) {
    console.log(`\n${label} downloads the selected candidates need (each file once):`);
    let total = 0;
    for (const f of [...downloads.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      total += f.sizeBytes;
      console.log(`      ${f.key.padEnd(62)} ${f.repo}@${f.revision}  ${formatSize(f.sizeBytes).padStart(9)}  ${f.license ?? "licence not given"}  for ${f.recipes.join(", ")}`);
    }
    console.log(`      total: ${downloads.size} file(s), ${formatSize(total)} (${total} bytes)`);
  }
  console.log(`\n${label} summary:`);
  for (const line of summary) console.log(`      ${line}`);
}

function formatSize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

async function recipeRun(client, label, recipe, task, downloads) {
  const id = recipe.id;
  const prepared = await callPlan(client, { action: "prepare", task });
  const planId = prepared.data?.plan?.id;
  if (!planId) return `${id}: FAIL, prepare: ${prepared.summary}`;
  const bindings = bindingsFor(recipe);
  const proposals = Object.keys(bindings).length > 0 ? [{ recipeId: id, bindings }] : undefined;
  const proposed = await callPlan(client, { action: "propose", planId, ...(proposals ? { proposals } : {}) });
  const candidate = (proposed.data?.candidates ?? []).find((c) => c.recipe === `${id} r${recipe.revision}`);
  if (!candidate) {
    const blockers = Object.values(proposed.data?.plan?.blockers ?? {}).flat().filter((b) => String(b).startsWith(`${id}:`));
    return `${id}: NOT PRESENTED among ${(proposed.data?.candidates ?? []).map((c) => `${c.recipe} (${c.status})`).join(", ") || "no candidates"}${blockers.length ? `; ${blockers.join("; ")}` : ""}`;
  }
  console.log(`      candidate ${candidate.status}${candidate.acquisition ? `, ${candidate.acquisition.files.length} file(s), ${candidate.acquisition.total} to download` : ""}`);
  for (const b of candidate.blocking) console.log(`        blocking: ${b}`);
  for (const w of candidate.softFailures ?? []) console.log(`        soft: ${w}`);
  if (candidate.status !== "feasible" && candidate.status !== "acquirable") return `${id}: ${candidate.status.toUpperCase()}, ${candidate.blocking[0] ?? "see the blocking checks"}`;
  const selected = await callPlan(client, { action: "select", planId, candidateId: candidate.id });
  if (selected.status !== "ok") return `${id}: FAIL, select: ${selected.summary}`;
  const run = await callRun(client, { action: "prepare", planId });
  const actionPlan = run.data?.actionPlan;
  if (!actionPlan) return `${id}: FAIL, run prepare: ${run.error?.code ?? ""} ${run.summary}`;
  const acquire = actionPlan.effects.find((e) => e.kind === "acquire_models");
  console.log(`      effects: ${actionPlan.effects.map((e) => e.kind).join(", ")} (hash ${run.data.shortHash})`);
  for (const e of actionPlan.effects) {
    if (e.kind === "local_render") for (const i of e.inputs ?? []) console.log(`        input ${i.assetId} sha256 ${i.sha256.slice(0, 12)} ${i.sizeBytes} bytes`);
  }
  for (const f of acquire?.files ?? []) {
    console.log(`        download ${f.folder}/${f.file} from ${f.source.repo}@${f.source.revision} (${formatSize(f.source.sizeBytes)}, ${f.source.license ?? "licence not given"}) into ${f.destinationRoot}`);
    const key = `${f.folder}/${f.file}`;
    const entry = downloads.get(key) ?? { key, repo: f.source.repo, revision: f.source.revision, sizeBytes: f.source.sizeBytes, license: f.source.license, recipes: [] };
    entry.recipes.push(id);
    downloads.set(key, entry);
  }
  if (dry) return `${id}: DRY, ${candidate.status}${acquire ? `, downloads ${acquire.files.length} file(s), ${formatSize(acquire.files.reduce((n, f) => n + f.source.sizeBytes, 0))}` : ", nothing to download"}`;
  if (acquire && !allowDownloads) return `${id}: STOPPED after prepare, the run would download ${acquire.files.length} file(s); rerun with --downloads`;
  // The stand-in for the user: the terminal command's code, with the hash the plan shows.
  const { runArchitectCli } = await import("../../dist/services/architect/cli.js");
  const { ArchitectStore } = await import("../../dist/services/architect/store.js");
  const store = ArchitectStore.open(dataDir);
  let code;
  try {
    code = await runArchitectCli(["approve", run.data.approvalRequest.id], {
      store,
      io: { interactive: true, write: () => undefined, ask: async () => run.data.shortHash },
    });
  } finally {
    store.close();
  }
  if (code !== 0) return `${id}: FAIL, the terminal approval returned ${code}`;
  const started = await callRun(client, { action: "start", actionPlanId: actionPlan.id });
  const runId = started.data?.run?.id;
  if (!runId) return `${id}: FAIL, start: ${started.error?.code ?? ""} ${started.summary}`;
  let status;
  const deadline = Date.now() + 30 * 60 * 1000;
  do {
    await new Promise((r) => setTimeout(r, 3000));
    status = await callRun(client, { action: "status", runId });
  } while (!["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"].includes(status.data?.run?.state) && Date.now() < deadline);
  const r = status.data?.run;
  const dims = (status.data?.evaluations ?? []).find((e) => e.criterion === "output_dimensions");
  const finalized = await callRun(client, { action: "finalize", runId });
  const ok = (r?.state === "AWAITING_REVIEW" || r?.state === "COMPLETED") && status.data?.verdicts?.execution === "passed" && dims?.verdict === "pass";
  if (!ok) failures.push(`${id}: run ${runId} ${r?.state}`);
  return (
    `${id}: ${ok ? "OK" : "FAIL"}, run ${runId} ${r?.state}${r?.error ? ` (${r.error.code}: ${r.error.message})` : ""}, ` +
    `execution ${status.data?.verdicts?.execution}, output_dimensions ${dims?.verdict ?? "none"}, outputs ${(r?.outputs ?? []).map((o) => o.filename).join(" ") || "none"}, finalize ${finalized.status}`
  );
}

if (uploadMask) {
  // Before the session, so the server's first node-schema read lists the file.
  const { uploadImageHttp } = await import("../../dist/comfyui/client.js");
  const uploaded = await uploadImageHttp(MASK_NAME, maskPng(), "image/png", true);
  console.log(`uploaded ${MASK_NAME} (1024x1024 mask) into the target's input folder: ${JSON.stringify(uploaded)}`);
}

const off = mode === "on" ? undefined : await session(false);
const on = mode === "off" ? undefined : await session(true);
if (off && on) {
  const added = on.tools.filter((n) => !off.tools.includes(n));
  const removed = off.tools.filter((n) => !on.tools.includes(n));
  // Spec AT-12: the flag adds Architect tools and changes nothing else.
  check(removed.length === 0 && added.every((n) => n.startsWith("architect_")), `flag on adds only architect_* tools (${added.join(", ") || "none"})`);
}

rmSync(dataDir, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
