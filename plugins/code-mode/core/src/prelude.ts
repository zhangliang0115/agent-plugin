/**
 * Tool naming rules and the guest-side bootstrap that runs once per owner context.
 * The bootstrap is plain JavaScript (no template literals) so it can be evaluated
 * verbatim inside QuickJS. @module
 */

const JS_RESERVED_WORDS = [
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected',
  'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
  'void', 'while', 'with', 'yield',
];

/** Names the Code Mode globals or the JavaScript runtime already use. Tools with these names stay in `tools[name]`. */
const RESERVED_GLOBALS = [
  'self', 'console', 'preview', 'tools', 'require', 'process', 'globalThis', 'undefined', 'NaN',
  'Infinity', 'eval', 'arguments', 'Promise', 'JSON', 'Object', 'Array', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'Reflect', 'Symbol', 'Math', 'String', 'Number',
  'Boolean', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Function', 'Proxy',
  'Intl',
];

const RESERVED = new Set([...JS_RESERVED_WORDS, ...RESERVED_GLOBALS]);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** True when a tool may also be reached as a bare global function. */
export function isGlobalToolName(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/** Filters tool names down to those that become bare global functions. */
export function globalToolNames(names: readonly string[]): string[] {
  return names.filter(isGlobalToolName);
}

/**
 * Guest source for one owner context. Evaluating it yields a function that takes
 * the host bridge (`invoke(id, name, argsJson)`, `done(runId, ok, text, hasResult, stack)`)
 * and the console ring size, and returns the control surface used by the sandbox.
 *
 * The guest settles tool calls only when the host calls `settle`. Every tool call
 * returns a promise, so `Promise.all` runs calls concurrently.
 *
 * Built-ins the bootstrap needs are captured once, at creation, so a program that
 * declares a top-level `const Object = ...` cannot break the bridge for later runs.
 */
export const GUEST_BOOTSTRAP = `(function (__cmInvoke, __cmDone, __cmRing, __cmLogChars) {
  var J = JSON;
  var P = Promise;
  var O = Object;
  var A = Array;
  var E = Error;
  var M = Map;
  var S = Set;
  var X = Proxy;
  var ST = String;
  var NM = Number;
  var MT = Math;
  var G = globalThis;
  var RING = __cmRing;
  var LOG_CHARS = __cmLogChars;
  var pending = new M();
  var seq = 0;
  var logLines = [];
  var logChars = 0;
  var logTruncated = false;
  var ring = [];
  var installed = [];

  function replacer(key, value) {
    if (typeof value === "bigint") return value.toString() + "n";
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (typeof value === "symbol") return ST(value);
    if (value instanceof M) return O.fromEntries(value);
    if (value instanceof S) return A.from(value);
    return value;
  }

  function formatValue(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "bigint") return value.toString() + "n";
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (typeof value === "symbol") return ST(value);
    if (value instanceof E) return value.name + ": " + value.message;
    if (typeof value === "object") {
      try {
        var text = J.stringify(value, replacer, 2);
        if (text !== undefined) return text;
      } catch (e) {
        return ST(value);
      }
    }
    return ST(value);
  }

  function formatError(error) {
    try {
      if (error instanceof E) return error.name + ": " + error.message;
      return formatValue(error);
    } catch (e) {
      return "error";
    }
  }

  function pushRing(level, args) {
    ring.push({ level: level, text: args.map(formatValue).join(" ") });
    while (ring.length > RING) ring.shift();
  }

  var consoleObj = {
    log: function () { pushRing("log", A.prototype.slice.call(arguments)); },
    info: function () { pushRing("info", A.prototype.slice.call(arguments)); },
    warn: function () { pushRing("warn", A.prototype.slice.call(arguments)); },
    error: function () { pushRing("error", A.prototype.slice.call(arguments)); },
    debug: function () { pushRing("debug", A.prototype.slice.call(arguments)); },
    tail: function (count) {
      var n = count === undefined ? 20 : MT.max(0, MT.floor(NM(count)));
      return ring.slice(MT.max(0, ring.length - n)).map(function (entry) {
        return entry.level + ": " + entry.text;
      });
    }
  };

  // Kept above the model-facing limit so the envelope truncates precisely; this budget only stops a
  // logging loop from exhausting the QuickJS heap.
  var LOG_BUDGET = MT.max(LOG_CHARS * 4, 65536);

  var selfObj = {
    log: function () {
      var line = A.prototype.slice.call(arguments).map(formatValue).join(" ");
      var room = LOG_BUDGET - logChars;
      if (room <= 0) {
        logTruncated = true;
        return;
      }
      var kept = line.length > room ? line.slice(0, room) : line;
      logLines.push(kept);
      logChars += kept.length + 1;
      if (kept.length < line.length) logTruncated = true;
    }
  };

  function preview(value, count) {
    var limit = count === undefined ? 2000 : MT.max(0, MT.floor(NM(count)));
    var text = formatValue(value);
    if (text.length <= limit) return text;
    return text.slice(0, limit) + "\\n[preview truncated: " + (text.length - limit) + " more characters]";
  }

  function call(name, args) {
    return new P(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      var text;
      try {
        text = J.stringify(args === undefined ? {} : args);
        if (text === undefined) text = "{}";
      } catch (e) {
        pending.delete(id);
        reject(e);
        return;
      }
      __cmInvoke(id, name, text);
    });
  }

  function settle(id, ok, payload, infoJson) {
    var entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    if (!ok) {
      var failure = new E(payload);
      if (infoJson) {
        try {
          var info = J.parse(infoJson);
          if (info.code !== undefined) failure.code = info.code;
          if (info.errorName !== undefined) failure.errorName = info.errorName;
        } catch (e) {}
      }
      entry.reject(failure);
      return;
    }
    var value;
    try {
      value = J.parse(payload);
    } catch (e) {
      entry.reject(e);
      return;
    }
    entry.resolve(value);
  }

  var toolsObj = O.create(null);

  function setTools(allJson, globalsJson) {
    var all = J.parse(allJson);
    var globals = J.parse(globalsJson);
    for (var i = 0; i < installed.length; i++) delete G[installed[i]];
    installed = [];
    toolsObj = O.create(null);
    all.forEach(function (name) {
      toolsObj[name] = async function (args) { return call(name, args); };
    });
    globals.forEach(function (name) {
      G[name] = toolsObj[name];
      installed.push(name);
    });
    G.tools = toolsObj;
  }

  function requireDenied() {
    throw new E("require is not available in Code Mode; use the listed tools");
  }

  var processGuard = new X(O.create(null), {
    get: function () { throw new E("process is not available in Code Mode; use the listed tools"); },
    set: function () { throw new E("process is not available in Code Mode; use the listed tools"); }
  });

  G.self = selfObj;
  G.console = consoleObj;
  G.preview = preview;
  G.require = requireDenied;
  G.process = processGuard;

  function stackOf(error) {
    try {
      return error && typeof error.stack === "string" ? error.stack : "";
    } catch (e) {
      return "";
    }
  }

  function run(program, hasResult, runId) {
    logLines = [];
    logChars = 0;
    logTruncated = false;
    P.resolve().then(program).then(
      function (value) {
        var text = "";
        try {
          text = hasResult ? formatValue(value) : "";
        } catch (e) {
          text = "error";
        }
        __cmDone(runId, true, text, hasResult, "");
      },
      function (error) {
        __cmDone(runId, false, formatError(error), hasResult, stackOf(error));
      }
    );
  }

  function takeLog() {
    var text = logLines.join("\\n") + (logTruncated ? "\\n[log truncated]" : "");
    logLines = [];
    logChars = 0;
    logTruncated = false;
    return text;
  }

  return { settle: settle, run: run, setTools: setTools, takeLog: takeLog };
})`;
