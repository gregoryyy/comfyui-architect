// ComfyUI Architect no-egress recorder (spec §19.2 AT-09; TODO 6.5.2; ARCH 2026-11-16,
// milestone 6, acceptance suite). Loaded into the server with `node --import`, it records
// what the process does that could reach another machine, one JSON line each, to the file
// named by ARCHITECT_EGRESS_LOG:
//   - TCP: global fetch, http and https requests, net.connect and net.createConnection,
//     tls.connect, and net.Socket's connect, which every TCP connection passes through
//     (undici's fetch included), each with host and port or a local socket path;
//   - DNS: dns.lookup, lookupService, resolve* and reverse, module-level, on dns.promises and
//     on both Resolver classes, with the name or address asked for;
//   - UDP: dgram sockets' send and connect, with the destination;
//   - child processes: spawn, spawnSync, execFile, execFileSync, exec, execSync and fork,
//     with the program's base name only. Its arguments are not recorded: they may carry
//     tokens. A child is another process this guard isn't loaded into, so the runner can't
//     vouch for what a program other than node does (AT-09 `unknown`).
// The first line is a `startup` record listing what was patched, so a log from a guard that
// couldn't patch something, or never ran, can't pass for a clean one.
//
// It records and never blocks: a call goes ahead as it would without the guard. Every line
// carries `seq`, numbered per process, so a line that wasn't written shows up as a gap. A
// failed write is also counted and appended to `<log>.errors`, which the runner treats as an
// incomplete log; when even that file can't be written, only the gap remains. One connection
// usually appears under several layers (fetch, dns.lookup, socket.connect); the runner reads
// them by kind and time window, so the duplicates don't matter. Without ARCHITECT_EGRESS_LOG
// the module installs nothing.
//
// ComfyUI's own traffic isn't covered: it is another process (spec §19.2, deployment-level).

import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

/** The environment variable naming the JSON-lines file the guard appends to. */
export const EGRESS_LOG_ENV = "ARCHITECT_EGRESS_LOG";

const DNS_METHODS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
];

function portOf(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

const unbracket = (host) => (typeof host === "string" ? host.replace(/^\[|\]$/g, "") : undefined);

/** Host and port of a URL string or object, with the scheme's default port. */
function fromUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(String(input));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return undefined;
    const port = portOf(url.port) ?? (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80);
    return { host: unbracket(url.hostname), port };
  } catch {
    return { host: undefined, port: undefined };
  }
}

/** Host and port of an options object as http, net and tls take it. */
function fromOptions(o, defaultPort) {
  if (o === null || typeof o !== "object") return { host: undefined, port: undefined };
  if (typeof o.path === "string" && o.host === undefined && o.hostname === undefined && o.port === undefined && !("protocol" in o)) {
    // net's IPC form: a socket path, no host.
    return { path: o.path };
  }
  if (typeof o.socketPath === "string") return { path: o.socketPath };
  // http, net and tls all default a missing host to localhost.
  return { host: unbracket(o.hostname ?? o.host ?? "localhost"), port: portOf(o.port) ?? defaultPort };
}

/** Destination of http(s).request(url | options, [options], [callback]). */
function fromRequestArgs(args, defaultPort) {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL) {
    const fromU = fromUrl(first) ?? { host: undefined, port: undefined };
    // Options after a URL override its fields.
    if (second && typeof second === "object") {
      const host = second.hostname ?? second.host;
      return { host: typeof host === "string" ? unbracket(host) : fromU.host, port: portOf(second.port) ?? fromU.port };
    }
    return fromU;
  }
  return fromOptions(first, defaultPort);
}

/** Destination of net/tls connect(options | port, [host] | path, ...). */
function fromConnectArgs(args, defaultPort) {
  let [first, second] = args;
  // net passes already normalised arguments to Socket#connect as an array.
  if (Array.isArray(first)) [first, second] = first;
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { host: typeof second === "string" ? second : "localhost", port: portOf(first) };
  }
  if (typeof first === "string") return { path: first };
  return fromOptions(first, defaultPort);
}

/** The name or address a dns call asks about; lookupService also takes a port. */
function fromDnsArgs(method, args) {
  const [first, second] = args;
  const host = typeof first === "string" ? unbracket(first) : undefined;
  return method === "lookupService" ? { host, port: portOf(second) } : { host };
}

/**
 * A program's base name, from a file or the first word of a shell command. Anything that
 * isn't a plain name (an `X=y` assignment, quoting the guard doesn't parse) is recorded as
 * `(unreadable)`, so no argument or value ends up in the log.
 */
function commandName(raw) {
  if (typeof raw !== "string" && !(raw instanceof URL)) return "(unreadable)";
  const text = raw instanceof URL ? raw.pathname : raw;
  const first = text.trim().split(/\s+/)[0] ?? "";
  const name = first.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";
  return /^[A-Za-z0-9._+-]{1,64}$/.test(name) ? name : "(unreadable)";
}

/** The peer of a connected dgram socket; undefined when it isn't connected. */
function dgramPeer(socket) {
  try {
    const peer = socket.remoteAddress();
    return { host: unbracket(peer.address), port: peer.port };
  } catch {
    // remoteAddress throws for a socket that isn't connected (or is closed): its send names
    // the destination itself.
    return undefined;
  }
}

/** Destination of dgram's send(msg, [offset, length,] port, [address], [cb]), as node reads it. */
function fromDgramSend(args, socket) {
  const peer = dgramPeer(socket);
  if (peer) return peer;
  const [, offset, length, port, address] = args;
  // lib/dgram.js: the long form when `address` is set or `port` is a non-function value.
  const [p, a] = address || (port && typeof port !== "function") ? [port, address] : [offset, length];
  return { host: typeof a === "string" && a !== "" ? unbracket(a) : "localhost", port: portOf(p) };
}

/** Destination of dgram's connect(port, [address], [cb]). */
function fromDgramConnect(args) {
  const [port, address] = args;
  return { host: typeof address === "string" && address !== "" ? unbracket(address) : "localhost", port: portOf(port) };
}

/**
 * Install the recorder; returns a function that restores every patched function. `file` is
 * the JSON-lines log, `now` the clock (milliseconds), injectable for tests.
 */
export function installEgressGuard({ file, now = Date.now } = {}) {
  if (!file) throw new Error(`installEgressGuard needs a log file (${EGRESS_LOG_ENV})`);
  let seq = 0;
  let failures = 0;
  const write = (line) => {
    const n = seq++;
    try {
      appendFileSync(file, `${JSON.stringify({ ...line, seq: n })}\n`);
    } catch (err) {
      // Recording must never change what the server does, so the call goes on; the failure
      // is counted where the runner looks for it.
      failures += 1;
      try {
        appendFileSync(`${file}.errors`, `${JSON.stringify({ at: now(), seq: n, failures, code: err && typeof err.code === "string" ? err.code : "unknown" })}\n`);
      } catch {
        // Neither file can be written: the missing `seq` is all the runner has to go on.
      }
    }
  };
  const record = (via, kind, dest) => {
    if (dest === undefined) return;
    write({
      at: now(),
      via,
      ...(kind ? { kind } : {}),
      ...(dest.host !== undefined ? { host: dest.host } : {}),
      ...(dest.port !== undefined ? { port: dest.port } : {}),
      ...(dest.path !== undefined ? { path: dest.path } : {}),
      ...(dest.command !== undefined ? { command: dest.command } : {}),
      pid: process.pid,
    });
  };
  const safe = (fn) => {
    try {
      fn();
    } catch {
      // A destination that can't be read is not a reason to refuse the call; the record
      // written for it, if any, lacks a host and so doesn't count as local.
    }
  };
  const restores = [];
  const patched = [];
  const patch = (owner, name, via, kind, extract) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrap = (target) =>
      function (...args) {
        safe(() => record(via, kind, extract(args, this)));
        return target.apply(this, args);
      };
    const wrapped = wrap(original);
    // Node keeps promisify's contract on symbols of the function: dns.lookup's result names
    // (customPromisifyArgs) and execFile's own promise form (promisify.custom). Copied, or
    // wrapped where it is a function, so `promisify(fn)` behaves as before and is recorded.
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      const desc = Object.getOwnPropertyDescriptor(original, key);
      if (key === promisify.custom && typeof desc?.value === "function") {
        Object.defineProperty(wrapped, key, { ...desc, value: wrap(desc.value) });
      } else if (desc) {
        Object.defineProperty(wrapped, key, desc);
      }
    }
    Object.defineProperty(wrapped, "name", { value: original.name });
    owner[name] = wrapped;
    patched.push(via);
    restores.push(() => {
      owner[name] = original;
    });
  };

  if (typeof globalThis.fetch === "function") {
    patch(globalThis, "fetch", "fetch", undefined, ([input]) => {
      const url = typeof input === "string" || input instanceof URL ? input : input && typeof input.url === "string" ? input.url : undefined;
      return url === undefined ? { host: undefined, port: undefined } : fromUrl(url);
    });
  }
  patch(http, "request", "http.request", undefined, (args) => fromRequestArgs(args, 80));
  patch(http, "get", "http.get", undefined, (args) => fromRequestArgs(args, 80));
  patch(https, "request", "https.request", undefined, (args) => fromRequestArgs(args, 443));
  patch(https, "get", "https.get", undefined, (args) => fromRequestArgs(args, 443));
  patch(net, "connect", "net.connect", undefined, (args) => fromConnectArgs(args, undefined));
  patch(net, "createConnection", "net.createConnection", undefined, (args) => fromConnectArgs(args, undefined));
  patch(tls, "connect", "tls.connect", undefined, (args) => fromConnectArgs(args, 443));
  patch(net.Socket.prototype, "connect", "socket.connect", undefined, (args) => fromConnectArgs(args, undefined));

  // The module-level resolve* functions are bound to the default resolver when dns loads, and
  // dns.setServers binds them again from Resolver.prototype, so both are patched.
  const dnsOwners = [
    [dns, "dns"],
    [dns.promises, "dns.promises"],
    [dns.Resolver.prototype, "dns.Resolver"],
    [dns.promises.Resolver.prototype, "dns.promises.Resolver"],
  ];
  for (const [owner, label] of dnsOwners) {
    for (const method of DNS_METHODS) {
      if (Object.hasOwn(owner, method)) patch(owner, method, `${label}.${method}`, "dns", (args) => fromDnsArgs(method, args));
    }
  }
  patch(dgram.Socket.prototype, "send", "dgram.send", "udp", (args, socket) => fromDgramSend(args, socket));
  patch(dgram.Socket.prototype, "connect", "dgram.connect", "udp", (args) => fromDgramConnect(args));

  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
    patch(childProcess, name, `child_process.${name}`, "spawn", ([command]) => ({ command: commandName(command) }));
  }
  // fork always starts node: the binary is execPath, its first argument a module.
  patch(childProcess, "fork", "child_process.fork", "spawn", ([, second, third]) => {
    // fork(modulePath, [args], [options]): the options come second when args are left out.
    const options = Array.isArray(second) ? third : (second ?? third);
    const execPath = options && typeof options === "object" && typeof options.execPath === "string" ? options.execPath : process.execPath;
    return { command: commandName(execPath) };
  });

  // ESM named imports of builtins (`import { connect } from "node:net"`) see the patches only
  // after this.
  syncBuiltinESMExports();
  write({ at: now(), via: "startup", kind: "startup", patched: [...patched], execName: basename(process.execPath), pid: process.pid });
  return () => {
    for (const restore of restores.splice(0).reverse()) restore();
    syncBuiltinESMExports();
  };
}

const logFile = process.env[EGRESS_LOG_ENV];
if (logFile) installEgressGuard({ file: logFile });
