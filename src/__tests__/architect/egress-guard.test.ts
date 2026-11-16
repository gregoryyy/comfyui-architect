// The AT-09 egress recorder (scripts/architect/egress-guard.mjs; TODO 6.5.2): it records the
// destination of every fetch, http and https request, net and tls connection, without
// blocking any, and restores every function on uninstall. Only loopback servers are used;
// nothing here leaves the machine.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EGRESS_LOG_ENV as RUNNER_EGRESS_LOG_ENV, egressViolations, parseEgressLog } from "../../services/architect/acceptance.js";
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
    const { records: lines, unreadable } = records();
    expect(unreadable).toBe(0);
    const vias = new Set(lines.map((l) => l.via));
    for (const v of ["fetch", "http.get", "net.connect", "socket.connect"]) expect(vias.has(v), v).toBe(true);
    for (const l of lines) {
      expect(l.host).toBe("127.0.0.1");
      expect(l.port).toBe(port);
      expect(l.pid).toBe(process.pid);
    }
    expect(lines.map((l) => l.at)).toEqual([...lines.map((l) => l.at)].sort((a, b) => a - b));
    expect(egressViolations(lines, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
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
    const hosts = egressViolations(records().records, 0, Number.MAX_SAFE_INTEGER);
    expect(hosts).toEqual(["192.0.2.1:9", "192.0.2.2:443", "192.0.2.3:8443"]);
    const vias = new Set(records().records.map((r) => r.via));
    for (const v of ["net.connect", "tls.connect", "https.request"]) expect(vias.has(v), v).toBe(true);
  });

  it("records a local socket path as local, and nothing for a data: URL", async () => {
    uninstall = installEgressGuard({ file });
    const s = net.connect(join(dir, "no-such.sock"));
    await new Promise<void>((resolve) => s.on("error", () => resolve()));
    await fetch("data:text/plain,hi");
    const { records: lines } = records();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.path).toBe(join(dir, "no-such.sock"));
    expect(egressViolations(lines, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("restores every patched function on uninstall and records nothing after it", async () => {
    const before = { fetch: globalThis.fetch, request: http.request, connect: net.connect, tls: tls.connect, socket: net.Socket.prototype.connect };
    const off = installEgressGuard({ file });
    expect(globalThis.fetch).not.toBe(before.fetch);
    expect(net.Socket.prototype.connect).not.toBe(before.socket);
    off();
    expect({ fetch: globalThis.fetch, request: http.request, connect: net.connect, tls: tls.connect, socket: net.Socket.prototype.connect }).toEqual(before);
    await fetch(`http://127.0.0.1:${port}/`);
    expect(records().records).toEqual([]);
  });

  it("keeps the call working when the log can't be written", async () => {
    uninstall = installEgressGuard({ file: join(dir, "missing-dir", "egress.jsonl") });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
  });

  it("reads the log file's name from the variable the runner sets", () => {
    expect(EGRESS_LOG_ENV).toBe(RUNNER_EGRESS_LOG_ENV);
  });

  it("refuses to install without a log file", () => {
    expect(() => installEgressGuard({})).toThrow(/log file/);
  });
});
