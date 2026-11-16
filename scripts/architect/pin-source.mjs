#!/usr/bin/env node
// Pin a model file's Hugging Face source for a recipe's `modelSources` (TODO 4.3; ARCH
// 2026-11-16, milestone 4, sources). A maintainer tool: planning never calls it and needs no
// network, because a recipe carries the pinned entry this prints (spec §9.2: the agent never
// supplies a source or URL).
//
// Usage: node scripts/architect/pin-source.mjs <repo> <path> [revision] --folder <folder> [--file <name>]
//   <repo>       owner/name on huggingface.co; a renamed repository is followed to its new
//                name, which the entry records and stderr reports
//   <path>       the file's path in the repository, e.g. split_files/vae/ae.safetensors
//   [revision]   branch, tag or commit to resolve (default main); the entry always records
//                the 40-character commit it resolved to, never the branch
//   --folder     the ComfyUI model folder the file is placed in (vae, upscale_models, ...)
//   --file       the file name on disk; default the last segment of <path>
//
// It reads /api/models/<repo>/revision/<revision> for the commit, licence and gating, and
// /api/models/<repo>/tree/<commit>/<dir> for the file's size and sha256 (the LFS object
// id). A file without an LFS entry has no sha256 from Hugging Face and is refused. Prints
// the entry as JSON on stdout; notes go to stderr. Node built-ins only.

const API = "https://huggingface.co/api/models";
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

function fail(message) {
  console.error(`pin-source: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--folder" || a === "--file") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail(`${a} needs a value`);
      flags[a.slice(2)] = value;
    } else if (a.startsWith("--")) {
      fail(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [repo, path, revision = "main", ...rest] = positional;
  if (!repo || !path || rest.length > 0 || !flags.folder) {
    fail("usage: pin-source.mjs <repo> <path> [revision] --folder <folder> [--file <name>]");
  }
  return { repo, path, revision, folder: flags.folder, file: flags.file };
}

/** The same rules the `ModelSource` schema enforces, checked before any request. */
function checkPath(path) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === ".." || s === "." || s === "")) {
    fail(`path ${JSON.stringify(path)} must be relative, without "..", "." or empty segments and without backslashes`);
  }
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function getJson(url) {
  // fetch follows redirects: Hugging Face answers a renamed repository with one.
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) fail(`GET ${url}: HTTP ${res.status}`);
  const finalHost = new URL(res.url).hostname;
  if (finalHost !== "huggingface.co") fail(`GET ${url} ended at ${res.url}, not on huggingface.co`);
  return { body: await res.json(), url: res.url };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!REPO_RE.test(args.repo)) fail(`repo ${JSON.stringify(args.repo)} isn't owner/name`);
  checkPath(args.path);
  const file = args.file ?? args.path.split("/").pop();
  if (!file || file.includes("/")) fail(`file ${JSON.stringify(file)} must be a bare file name`);

  const rev = await getJson(`${API}/${args.repo}/revision/${encodeURIComponent(args.revision)}`);
  const repo = rev.body.id;
  const commit = rev.body.sha;
  if (typeof repo !== "string" || !REPO_RE.test(repo)) fail(`the revision answer names no repository id`);
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) fail(`the revision answer names no 40-digit commit`);
  if (repo !== args.repo) console.error(`pin-source: ${args.repo} resolves to ${repo}; the entry records ${repo}`);
  const gated = rev.body.gated;
  if (gated !== undefined && gated !== false) console.error(`pin-source: ${repo} is gated (${String(gated)}); a download needs HF_TOKEN`);
  const license = rev.body.cardData?.license;

  const slash = args.path.lastIndexOf("/");
  const dir = slash === -1 ? "" : args.path.slice(0, slash);
  const treeUrl = `${API}/${repo}/tree/${commit}${dir ? `/${encodePath(dir)}` : ""}`;
  const tree = await getJson(treeUrl);
  if (!Array.isArray(tree.body)) fail(`GET ${treeUrl} didn't return a listing`);
  const entry = tree.body.find((e) => e && e.type === "file" && e.path === args.path);
  if (!entry) fail(`${repo}@${commit} has no file ${args.path}`);
  const sha256 = entry.lfs?.oid;
  const size = entry.lfs?.size ?? entry.size;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    fail(`${args.path} has no LFS sha256; Hugging Face reports only a git object id for it`);
  }
  if (!Number.isSafeInteger(size) || size <= 0) fail(`${args.path} has no positive size`);

  const out = {
    folder: args.folder,
    file,
    source: {
      kind: "huggingface",
      repo,
      revision: commit,
      path: args.path,
      sha256,
      sizeBytes: size,
      ...(typeof license === "string" && license.length > 0 ? { license } : {}),
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
