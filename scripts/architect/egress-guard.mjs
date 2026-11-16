// ComfyUI Architect no-egress recorder (spec §19.2 AT-09; TODO 6.5.2; ARCH 2026-11-16,
// milestone 6, acceptance suite). Loaded into the server with `node --import`, it records
// every outbound destination the process opens, one JSON line each, to the file named by
// ARCHITECT_EGRESS_LOG: global fetch, http and https requests, net.connect and
// net.createConnection, tls.connect, and net.Socket's connect, which every TCP connection
// passes through (undici's fetch included), each with host and port or a local socket path.
//
// It records and never blocks: a connection goes ahead as it would without the guard, and a
// failure to write a record is swallowed so the server isn't changed by it. One connection
// usually appears under several layers (fetch, then socket.connect); the acceptance runner
// reads them by time window, so the duplicates don't matter. Without ARCHITECT_EGRESS_LOG
// the module installs nothing.
//
// ComfyUI's own traffic isn't covered: it is another process (spec §19.2, deployment-level).

import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

/** The environment variable naming the JSON-lines file the guard appends to. */
export const EGRESS_LOG_ENV = "ARCHITECT_EGRESS_LOG";

function portOf(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

/** Host and port of a URL string or object, with the scheme's default port. */
function fromUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(String(input));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return undefined;
    const port = portOf(url.port) ?? (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80);
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
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
  const host = o.hostname ?? o.host ?? "localhost";
  return { host: typeof host === "string" ? host.replace(/^\[|\]$/g, "") : undefined, port: portOf(o.port) ?? defaultPort };
}

/** Destination of http(s).request(url | options, [options], [callback]). */
function fromRequestArgs(args, defaultPort) {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL) {
    const fromU = fromUrl(first) ?? { host: undefined, port: undefined };
    // Options after a URL override its fields.
    if (second && typeof second === "object") {
      const host = second.hostname ?? second.host;
      return { host: typeof host === "string" ? host.replace(/^\[|\]$/g, "") : fromU.host, port: portOf(second.port) ?? fromU.port };
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

/**
 * Install the recorder; returns a function that restores every patched function. `file` is
 * the JSON-lines log, `now` the clock (milliseconds), injectable for tests.
 */
export function installEgressGuard({ file, now = Date.now } = {}) {
  if (!file) throw new Error(`installEgressGuard needs a log file (${EGRESS_LOG_ENV})`);
  const record = (via, dest) => {
    if (dest === undefined) return;
    try {
      const line = { at: now(), via, ...(dest.host !== undefined ? { host: dest.host } : {}), ...(dest.port !== undefined ? { port: dest.port } : {}), ...(dest.path !== undefined ? { path: dest.path } : {}), pid: process.pid };
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch {
      // Recording must never change what the server does; a lost line shows up as a gap.
    }
  };
  const safe = (fn) => {
    try {
      fn();
    } catch {
      // As above: a destination that can't be read is not a reason to refuse the call.
    }
  };
  const restores = [];
  const patch = (owner, name, via, extract) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      safe(() => record(via, extract(args)));
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, "name", { value: original.name });
    owner[name] = wrapped;
    restores.push(() => {
      owner[name] = original;
    });
  };

  if (typeof globalThis.fetch === "function") {
    patch(globalThis, "fetch", "fetch", ([input]) => {
      const url = typeof input === "string" || input instanceof URL ? input : input && typeof input.url === "string" ? input.url : undefined;
      return url === undefined ? { host: undefined, port: undefined } : fromUrl(url);
    });
  }
  patch(http, "request", "http.request", (args) => fromRequestArgs(args, 80));
  patch(http, "get", "http.get", (args) => fromRequestArgs(args, 80));
  patch(https, "request", "https.request", (args) => fromRequestArgs(args, 443));
  patch(https, "get", "https.get", (args) => fromRequestArgs(args, 443));
  patch(net, "connect", "net.connect", (args) => fromConnectArgs(args, undefined));
  patch(net, "createConnection", "net.createConnection", (args) => fromConnectArgs(args, undefined));
  patch(tls, "connect", "tls.connect", (args) => fromConnectArgs(args, 443));
  patch(net.Socket.prototype, "connect", "socket.connect", (args) => fromConnectArgs(args, undefined));
  // ESM named imports of builtins (`import { connect } from "node:net"`) see the patches only
  // after this.
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores.splice(0).reverse()) restore();
    syncBuiltinESMExports();
  };
}

const logFile = process.env[EGRESS_LOG_ENV];
if (logFile) installEgressGuard({ file: logFile });
