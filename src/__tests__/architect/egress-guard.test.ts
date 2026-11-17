// The AT-09 egress recorder (scripts/architect/egress-guard.mjs; TODO 6.5.2): it records the
// destination of every fetch, http and https request, net and tls connection, DNS query and
// UDP send, and every child process by its program's name, without blocking any; writes a
// startup line listing its patches; numbers its lines and reports failed writes; and restores
// every function on uninstall. Destinations are loopback servers, or TEST-NET-1 addresses
// (RFC 5737) on calls that fail or are destroyed before anything is sent; nothing here
// leaves the machine.

import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EGRESS_LOG_ENV as RUNNER_EGRESS_LOG_ENV, egressViolations, parseEgressLog } from "../../services/architect/acceptance.js";
import { REQUIRED_PATCHES, at09Verdict, classifyEgress } from "../../../scripts/architect/acceptance-judge.mjs";
import { EGRESS_LOG_ENV, installEgressGuard } from "../../../scripts/architect/egress-guard.mjs";

let dir: string;
let file: string;
let server: http.Server;
let port: number;
let uninstall: (() => void) | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "architect-egress-"));
  file = join(dir, "egress.jsonl");
  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function records() {
  // The guard creates the file with its first line, so no file is a log without lines.
  return parseEgressLog(existsSync(file) ? readFileSync(file, "utf-8") : "");
}

/** The records that name a destination, without the startup line and child processes. */
function destinations() {
  return classifyEgress(records().records).destinations;
}

const everywhere = (rs: Parameters<typeof egressViolations>[0]) => egressViolations(rs, 0, Number.MAX_SAFE_INTEGER);

function verdict(sidecarExists = false) {
  return at09Verdict({ logExists: existsSync(file), log: records(), sidecarExists, violations: everywhere });
}

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

describe("the egress guard", () => {
  it("records fetch, http.get and net.connect to a loopback server with host and port, and lets them through", async () => {
    let t = 1000;
    uninstall = installEgressGuard({ file, now: () => t++ });
    const res = await fetch(`http://127.0.0.1:${port}/a`);
    expect(await res.text()).toBe("ok");
    expect(await get(`http://127.0.0.1:${port}/b`)).toBe(200);
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.end();
        resolve();
      });
      s.on("error", reject);
    });
    const { unreadable } = records();
    const lines = destinations();
    expect(unreadable).toBe(0);
    const vias = new Set(lines.map((l) => l.via));
    for (const v of ["fetch", "http.get", "net.connect", "socket.connect"]) expect(vias.has(v), v).toBe(true);
    for (const l of lines) {
      expect(l.host).toBe("127.0.0.1");
      expect(l.port).toBe(port);
      expect(l.pid).toBe(process.pid);
    }
    expect(lines.map((l) => l.at)).toEqual([...lines.map((l) => l.at)].sort((a, b) => a - b));
    expect(everywhere(lines)).toEqual([]);
    expect(verdict()).toMatchObject({ verdict: "passed", reasons: [] });
  });

  it("records a non-loopback destination before the connection fails, without blocking the attempt", async () => {
    uninstall = installEgressGuard({ file });
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): never routed. The socket is destroyed at once,
    // so nothing is sent; the record is made before the connect call proceeds.
    const s = net.connect({ host: "192.0.2.1", port: 9 });
    s.on("error", () => undefined);
    s.destroy();
    const t = tls.connect({ host: "192.0.2.2", port: 443 });
    t.on("error", () => undefined);
    t.destroy();
    const req = https.request("https://192.0.2.3:8443/x", { method: "HEAD" });
    req.on("error", () => undefined);
    req.destroy();
    const hosts = everywhere(destinations());
    expect(hosts).toEqual(["192.0.2.1:9", "192.0.2.2:443", "192.0.2.3:8443"]);
    const vias = new Set(destinations().map((r) => r.via));
    for (const v of ["net.connect", "tls.connect", "https.request"]) expect(vias.has(v), v).toBe(true);
    expect(verdict()).toMatchObject({ verdict: "failed", violations: hosts });
  });

  it("records a local socket path as local, and nothing for a data: URL", async () => {
    uninstall = installEgressGuard({ file });
    const s = net.connect(join(dir, "no-such.sock"));
    await new Promise<void>((resolve) => s.on("error", () => resolve()));
    await fetch("data:text/plain,hi");
    const lines = destinations();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.path).toBe(join(dir, "no-such.sock"));
    expect(everywhere(lines)).toEqual([]);
  });

  it("writes a numbered startup line first, listing every patch the runner requires", () => {
    uninstall = installEgressGuard({ file, now: () => 5 });
    const { records: lines, unreadable } = records();
    expect(unreadable).toBe(0);
    expect(lines).toHaveLength(1);
    const [first] = lines;
    expect(first).toMatchObject({ at: 5, via: "startup", kind: "startup", seq: 0, pid: process.pid, execName: basename(process.execPath) });
    const patched = Array.isArray(first.patched) ? first.patched : [];
    expect(REQUIRED_PATCHES.filter((p) => !patched.includes(p))).toEqual([]);
    expect(verdict()).toMatchObject({ verdict: "passed" });
  });

  it("records child processes by program name only, never their arguments, and node apart from other programs", async () => {
    uninstall = installEgressGuard({ file });
    // A program that doesn't exist: the spawn is recorded, then fails; nothing runs.
    const missing = "architect-no-such-program";
    const child = childProcess.spawn(missing, ["--token=s3cr3t-arg"]);
    await new Promise<void>((resolve) => child.on("error", () => resolve()));
    expect(childProcess.spawnSync(`/usr/local/bin/${missing}`, ["s3cr3t-arg"]).error).toBeDefined();
    expect(() => childProcess.execFileSync(missing, ["s3cr3t-arg"], { stdio: "ignore" })).toThrow();
    await new Promise<void>((resolve) => childProcess.execFile(missing, ["s3cr3t-arg"], () => resolve()));
    await promisify(childProcess.execFile)(missing, ["s3cr3t-arg"]).catch(() => undefined);
    // A shell line starting with an assignment: the name isn't a plain word, so it is not recorded.
    await new Promise<void>((resolve) => childProcess.exec(`TOKEN=s3cr3t-arg ${missing}`, () => resolve()));
    expect(() => childProcess.execSync(`${missing} s3cr3t-arg`, { stdio: "ignore" })).toThrow();
    expect(childProcess.spawnSync(process.execPath, ["-e", ""]).status).toBe(0);
    const module = join(dir, "child.mjs");
    writeFileSync(module, "process.exit(0);\n");
    await new Promise<void>((resolve) => childProcess.fork(module, [], { stdio: "ignore" }).on("exit", () => resolve()));

    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain("s3cr3t");
    const { spawns } = classifyEgress(records().records);
    const byVia = (via: string) => spawns.filter((s) => s.via === via).map((s) => s.command);
    expect(byVia("child_process.spawn")).toContain(missing);
    expect(byVia("child_process.spawnSync")).toEqual([missing, basename(process.execPath)]);
    expect(byVia("child_process.execFileSync")).toEqual([missing]);
    // promisify(execFile) goes through execFile's own promise form, which is wrapped too.
    expect(byVia("child_process.execFile").filter((c) => c === missing).length).toBeGreaterThanOrEqual(2);
    expect(byVia("child_process.exec")).toEqual(["(unreadable)"]);
    expect(byVia("child_process.execSync")).toEqual([missing]);
    expect(byVia("child_process.fork")).toEqual([basename(process.execPath)]);
    // Programs other than node leave AT-09 unknown: the guard can't see what they send.
    const v = verdict();
    expect(v.verdict).toBe("unknown");
    const foreign = v.reasons.find((r) => r.startsWith("child processes"));
    expect(foreign).toBe(`child processes the guard can't see into: (unreadable), ${missing}`);
  });

  it("counts a node child alone as covered", () => {
    uninstall = installEgressGuard({ file });
    expect(childProcess.spawnSync(process.execPath, ["-e", ""]).status).toBe(0);
    expect(verdict()).toMatchObject({ verdict: "passed", spawns: [basename(process.execPath)] });
  });

  it("records dns lookups and queries with the name asked for, and keeps promisify(dns.lookup)'s result", async () => {
    uninstall = installEgressGuard({ file });
    await new Promise<void>((resolve) => dns.lookup("localhost", () => resolve()));
    // An address literal resolves without a query.
    const viaPromise = await dns.promises.lookup("192.0.2.4");
    expect(viaPromise).toEqual({ address: "192.0.2.4", family: 4 });
    expect(await promisify(dns.lookup)("192.0.2.7")).toEqual({ address: "192.0.2.7", family: 4 });
    // No callback: node refuses the call before any query, after the guard recorded it.
    expect(() => Reflect.apply(dns.resolve4, dns, ["example.test"])).toThrow();
    // A resolver of its own whose server is a closed loopback port: the query stays local.
    const resolver = new dns.promises.Resolver({ timeout: 100, tries: 1 });
    resolver.setServers(["127.0.0.1:9"]);
    await resolver.resolve4("resolver.example.test").catch(() => undefined);
    const lines = destinations().filter((r) => r.kind === "dns");
    const vias = new Set(lines.map((r) => r.via));
    for (const v of ["dns.lookup", "dns.promises.lookup", "dns.resolve4", "dns.promises.Resolver.resolve4"]) expect(vias.has(v), v).toBe(true);
    expect(everywhere(lines)).toEqual(["192.0.2.4", "192.0.2.7", "example.test", "resolver.example.test"]);
    expect(verdict().verdict).toBe("failed");
  });

  it("records UDP sends and connects with their destination", async () => {
    uninstall = installEgressGuard({ file });
    const receiver = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => receiver.bind(0, "127.0.0.1", resolve));
    const udpPort = receiver.address().port;
    const got = new Promise<void>((resolve) => receiver.once("message", () => resolve()));
    const sender = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => sender.send("x", udpPort, "127.0.0.1", (err) => (err ? reject(err) : resolve())));
    await got;
    const connected = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => connected.connect(udpPort, "127.0.0.1", resolve));
    await new Promise<void>((resolve, reject) => connected.send("y", (err) => (err ? reject(err) : resolve())));
    // A closed socket refuses at once: recorded, and no packet goes anywhere.
    const closed = dgram.createSocket("udp4");
    closed.close();
    expect(() => closed.send("z", 9, "192.0.2.5")).toThrow();
    expect(() => closed.connect(9, "192.0.2.6")).toThrow();
    for (const s of [receiver, sender, connected]) s.close();

    const lines = destinations().filter((r) => r.kind === "udp");
    const local = lines.filter((r) => r.host === "127.0.0.1");
    // An unbound socket's send binds first and calls send again once bound: counted twice.
    expect(new Set(local.map((r) => r.via))).toEqual(new Set(["dgram.connect", "dgram.send"]));
    expect(local.filter((r) => r.via === "dgram.send").length).toBeGreaterThanOrEqual(2);
    for (const r of local) expect(r.port).toBe(udpPort);
    expect(everywhere(lines)).toEqual(["192.0.2.5:9", "192.0.2.6:9"]);
  });

  it("restores every patched function on uninstall and records nothing after it", async () => {
    const current = () => ({
      fetch: globalThis.fetch,
      request: http.request,
      connect: net.connect,
      tls: tls.connect,
      socket: net.Socket.prototype.connect,
      spawn: childProcess.spawn,
      execFile: childProcess.execFile,
      lookup: dns.lookup,
      promisesLookup: dns.promises.lookup,
      resolverResolve4: dns.Resolver.prototype.resolve4,
      send: dgram.Socket.prototype.send,
    });
    const before = current();
    const off = installEgressGuard({ file });
    const during = current();
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(during[key], key).not.toBe(before[key]);
    off();
    expect(current()).toEqual(before);
    await fetch(`http://127.0.0.1:${port}/`);
    childProcess.spawnSync(process.execPath, ["-e", ""]);
    expect(records().records.map((r) => r.kind)).toEqual(["startup"]);
  });

  it("keeps the call working when the log can't be written, and records the failures next to it", async () => {
    // The log's name is a directory, so every append fails; the sidecar beside it can be written.
    const asDir = join(dir, "log-is-a-dir");
    mkdirSync(asDir);
    uninstall = installEgressGuard({ file: asDir });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    const failures = readFileSync(`${asDir}.errors`, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    // The startup line and at least the fetch: numbered, counted, with the error code.
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures[0]).toMatchObject({ seq: 0, failures: 1, code: "EISDIR" });
    expect(failures.map((f) => f.failures)).toEqual(failures.map((_, i) => i + 1));
  });

  it("keeps the call working when neither the log nor its sidecar can be written", async () => {
    uninstall = installEgressGuard({ file: join(dir, "missing-dir", "egress.jsonl") });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
  });

  it("numbers lines so that a lost one shows as a gap", async () => {
    uninstall = installEgressGuard({ file });
    await fetch(`http://127.0.0.1:${port}/`);
    const text = readFileSync(file, "utf-8").trim().split("\n");
    expect(text.map((l) => JSON.parse(l).seq)).toEqual(text.map((_, i) => i));
    const dropped = parseEgressLog(text.filter((_, i) => i !== 1).join("\n"));
    const v = at09Verdict({ logExists: true, log: dropped, sidecarExists: false, violations: everywhere });
    expect(v.verdict).toBe("unknown");
    expect(v.reasons.join(" ")).toContain("missing from the sequence");
  });

  it("reads the log file's name from the variable the runner sets", () => {
    expect(EGRESS_LOG_ENV).toBe(RUNNER_EGRESS_LOG_ENV);
  });

  it("refuses to install without a log file", () => {
    expect(() => installEgressGuard({})).toThrow(/log file/);
  });
});
