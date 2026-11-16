#!/usr/bin/env node
// Import one template of a registered source as a draft recipe, for a maintainer to review
// (TODO 5.2; ARCH 2026-11-16, template import; spec §8.4). Planning never calls it.
//
// Usage: node scripts/architect/import-template.mjs <source> <name> [--out <file>]
//   <source>   comfyui-templates (the target's /templates/index.json) or upstream-packs
//   <name>     the template's name in the index, or the pack's directory name
//   --out      write the draft recipe to <file> and the conversion report next to it as
//              <file without .recipe.json or .json>.report.json, both as new files: an
//              existing file or a symbolic link in either place is refused; without it,
//              both go to stdout as one JSON object {recipe, report}
//
// The import runs against the configured target (COMFYUI_URL, COMFYUI_HOST/PORT, ...): its
// object_info converts the UI graph, and for comfyui-templates its index and workflow are
// read. The draft is `proposed` and carries no model pins; the report lists the template's
// model URLs as candidate sources only. The script refuses to write into architect/recipes/:
// a draft goes there only by a maintainer's review. The source registry it records refreshes
// in lives in a temporary data directory, removed at exit, so the user's architect.db isn't
// touched. Exits 0 for a draft, 1 for a failed import or a refusal, 2 for a usage error.
// Needs `npm run build` first.

import { closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

const DIST = new URL("../../dist/services/architect/", import.meta.url);

function usage(message) {
  console.error(`import-template: ${message}`);
  console.error("usage: import-template.mjs <source> <name> [--out <file>]");
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  let out;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      out = argv[++i];
      if (out === undefined || out.startsWith("--")) usage("--out needs a file");
    } else if (a.startsWith("--")) {
      usage(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) usage("expected a source and a template name");
  return { source: positional[0], name: positional[1], out };
}

/**
 * Write a new file: O_EXCL refuses an existing file, O_NOFOLLOW a symbolic link in its
 * place, so --out never overwrites a recipe or writes through a link.
 */
function writeNewFile(path, text) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "EEXIST" || code === "ELOOP") {
      console.error(`import-template: refusing to write ${path}: it already exists or is a symbolic link`);
      process.exit(1);
    }
    throw err;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Whether `path` is `dir` or inside it, comparing real paths where they exist. */
function inside(path, dir) {
  const real = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const rel = relative(real(dir), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(new URL("templates.js", DIST))) usage(`${new URL("templates.js", DIST).pathname} is missing; run npm run build first`);
  const { createUpstreamFacade } = await import(new URL("upstream.js", DIST).href);
  const { ArchitectStore } = await import(new URL("store.js", DIST).href);
  const { ensureBuiltInSources } = await import(new URL("sources.js", DIST).href);
  const { importTemplate, TemplateSourceError } = await import(new URL("templates.js", DIST).href);
  const { SHIPPED_RECIPES_DIR } = await import(new URL("catalog.js", DIST).href);

  let recipeFile;
  let reportFile;
  if (args.out) {
    recipeFile = resolve(args.out);
    if (inside(dirname(recipeFile), SHIPPED_RECIPES_DIR)) {
      console.error(`import-template: refusing to write into ${SHIPPED_RECIPES_DIR}; a draft goes there only after review`);
      process.exit(1);
    }
    reportFile = `${recipeFile.replace(/(\.recipe)?\.json$/, "")}.report.json`;
    // Both names are checked before either is written, so a refusal leaves neither behind;
    // writeNewFile refuses again at the open, which closes the gap between the two.
    for (const f of [recipeFile, reportFile]) {
      let taken = false;
      try {
        lstatSync(f);
        taken = true;
      } catch {
        taken = false;
      }
      if (taken) {
        console.error(`import-template: refusing to write ${f}: it already exists or is a symbolic link`);
        process.exit(1);
      }
    }
  }

  const upstream = createUpstreamFacade();
  const dataDir = mkdtempSync(join(tmpdir(), "architect-import-"));
  const store = ArchitectStore.open(dataDir);
  try {
    const registered = ensureBuiltInSources(store, upstream.comfyuiBaseUrl());
    for (const e of registered.errors) console.error(`import-template: source ${e.id} not registered: ${e.message}`);
    let result;
    try {
      result = await importTemplate({ store, upstream, now: () => new Date() }, args.source, args.name);
    } catch (err) {
      if (err instanceof TemplateSourceError) {
        console.error(`import-template: ${err.code}: ${err.message}`);
        return 1;
      }
      throw err;
    }
    const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
    if (recipeFile) {
      writeNewFile(reportFile, json(result.report));
      console.error(`import-template: report written to ${reportFile}`);
      if (result.ok) {
        writeNewFile(recipeFile, json(result.recipe));
        console.error(`import-template: draft ${result.recipe.id} written to ${recipeFile}`);
      }
    } else {
      process.stdout.write(json(result.ok ? { recipe: result.recipe, report: result.report } : { report: result.report }));
    }
    if (!result.ok) {
      console.error(`import-template: the import failed: ${result.report.failures.join("; ")}`);
      return 1;
    }
    for (const line of result.report.needsMaintainer) console.error(`import-template: needs a maintainer: ${line}`);
    return 0;
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`import-template: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
