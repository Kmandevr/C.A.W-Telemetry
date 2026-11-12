// Report and feedback schemas (v1): an allow-list. Unknown fields are dropped, wrong types are rejected, and
// numbers are rounded here as well as in the app, so nothing finer than the contract ever gets published.
// The contract is PLAN.md, "The contract with the app"; change both together.

export class SchemaError extends Error {}

const fail = (path, why) => { throw new SchemaError(`${path}: ${why}`); };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function obj(v, path) { if (!isObj(v)) fail(path, 'expected an object'); return v; }

function str(v, path, max, pattern) {
  if (typeof v !== 'string') fail(path, 'expected a string');
  if (v.length > max) fail(path, `longer than ${max}`);
  if (pattern && !pattern.test(v)) fail(path, 'bad format');
  return v;
}

function oneOf(v, path, allowed) {
  if (!allowed.includes(v)) fail(path, `expected one of ${allowed.join(', ')}`);
  return v;
}

function num(v, path, min, max, step = 1) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a number');
  if (v < min || v > max) fail(path, `outside ${min}..${max}`);
  return Math.round(v / step) * step;
}

function bool(v, path) { if (typeof v !== 'boolean') fail(path, 'expected true or false'); return v; }

// Free-text names (CPU, GPU) are trimmed to printable ASCII so nothing unexpected is published.
function label(v, path, max = 80) {
  return str(v, path, 200).replace(/[^\x20-\x7e]/g, '').trim().slice(0, max) || 'unknown';
}

// Ids (screens, built-ins): only C.A.W's own id shapes; anything else becomes "other".
const ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const BUILTIN = /^org\.caw\.[a-z0-9_.-]{1,48}$|^[a-z][a-z0-9_-]{0,31}(\.pro)?$/;

function idMap(v, path, valueMax, step, shape) {
  const out = {};
  for (const [k, n] of Object.entries(obj(v, path)).slice(0, 200)) {
    const key = shape.test(k) ? k : 'other';
    out[key] = (out[key] || 0) + num(n, `${path}.${key}`, 0, valueMax, step);
  }
  return out;
}

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
export const RECEIPT = HEX(32);
export const HASH = HEX(64);
const TIERS = ['comfortable', 'tight', 'over'];

export const PLATFORMS = ['android', 'ios', 'windows', 'macos', 'linux'];
const ARCHES = ['arm64', 'arm', 'x64', 'x86', 'riscv64', 'other'];
const FORMS = ['phone', 'tablet', 'laptop', 'desktop', 'tv', 'other', 'unknown'];
const PERIPHERAL_KINDS = ['audio-output', 'audio-input', 'audio-interface', 'midi', 'gamepad', 'keyboard', 'mouse', 'touch', 'pen',
  'display', 'storage', 'other'];
const LINKS = ['builtin', 'usb', 'bluetooth', 'wired', 'hdmi', 'displayport', 'network', 'other', 'unknown'];
const HEX4 = /^[0-9a-f]{4}$/;
const opt = (v, f) => (v === undefined || v === null ? undefined : f(v));
// A measurement the device couldn't give (owner, 2026-11-12): sent as null (or left out), stored as null, and left out
// of every average. Never 0, which would look like a real reading.
const unknown = (v, f) => (v === undefined || v === null ? null : f(v));

// A peripheral: its kind, how it's connected, and the maker's model name and USB ids. Never a name the user can set
// (a Bluetooth or device name), a serial number or a port path: PLAN.md, "Device and peripherals".
function peripheral(v, path) {
  v = obj(v, path);
  return {
    kind: oneOf(v.kind, `${path}.kind`, PERIPHERAL_KINDS),
    connection: oneOf(v.connection, `${path}.connection`, LINKS),
    model: opt(v.model, (x) => label(x, `${path}.model`, 60)),
    vendorId: opt(v.vendorId, (x) => str(x, `${path}.vendorId`, 4, HEX4)),
    productId: opt(v.productId, (x) => str(x, `${path}.productId`, 4, HEX4)),
    channels: opt(v.channels, (x) => num(x, `${path}.channels`, 0, 256)),
    inUse: opt(v.inUse, (x) => bool(x, `${path}.inUse`)),
  };
}

function device(v, path) {
  v = obj(v, path);
  const a = obj(v.audio, `${path}.audio`);
  const c = obj(v.cores, `${path}.cores`);
  const clocks = v.maxClockMHz === undefined || v.maxClockMHz === null ? []
    : Array.isArray(v.maxClockMHz) ? v.maxClockMHz.slice(0, 4) : fail(`${path}.maxClockMHz`, 'expected a list');
  const sc = v.screen === undefined ? undefined : obj(v.screen, `${path}.screen`);
  const per = v.peripherals === undefined ? undefined
    : Array.isArray(v.peripherals) ? v.peripherals.slice(0, 16) : fail(`${path}.peripherals`, 'expected a list');
  return {
    platform: oneOf(v.platform, `${path}.platform`, PLATFORMS),
    arch: opt(v.arch, (x) => oneOf(x, `${path}.arch`, ARCHES)),
    osName: opt(v.osName, (x) => label(x, `${path}.osName`, 40)),
    // Major, or major.minor.build (Windows 10.0.22631): never a full build fingerprint.
    osVersion: unknown(v.osVersion, (x) => str(x, `${path}.osVersion`, 16, /^[0-9]{1,5}(\.[0-9]{1,6}){0,2}$/)),
    manufacturer: opt(v.manufacturer, (x) => label(x, `${path}.manufacturer`, 40)),
    model: opt(v.model, (x) => label(x, `${path}.model`, 60)),
    formFactor: opt(v.formFactor, (x) => oneOf(x, `${path}.formFactor`, FORMS)),
    cpu: unknown(v.cpu, (x) => label(x, `${path}.cpu`)),
    cores: {
      big: unknown(c.big, (x) => num(x, `${path}.cores.big`, 0, 256)),
      little: unknown(c.little, (x) => num(x, `${path}.cores.little`, 0, 256)),
      other: unknown(c.other, (x) => num(x, `${path}.cores.other`, 0, 256)),
    },
    maxClockMHz: clocks.map((x, i) => unknown(x, (y) => num(y, `${path}.maxClockMHz[${i}]`, 0, 10000, 100))),
    ramGB: unknown(v.ramGB, (x) => num(x, `${path}.ramGB`, 0, 1024)),
    gpu: unknown(v.gpu, (x) => label(x, `${path}.gpu`)),
    refreshHz: unknown(v.refreshHz, (x) => num(x, `${path}.refreshHz`, 0, 1000)),
    screen: sc && {
      widthPx: num(sc.widthPx, `${path}.screen.widthPx`, 0, 20000, 10),
      heightPx: num(sc.heightPx, `${path}.screen.heightPx`, 0, 20000, 10),
      dpi: opt(sc.dpi, (x) => num(x, `${path}.screen.dpi`, 0, 2000, 10)),
      displays: opt(sc.displays, (x) => num(x, `${path}.screen.displays`, 0, 16)),
    },
    audio: {
      backend: str(a.backend, `${path}.audio.backend`, 16, /^[a-z0-9_]{1,16}$/),
      exclusive: unknown(a.exclusive, (x) => bool(x, `${path}.audio.exclusive`)),
      lowLatency: unknown(a.lowLatency, (x) => bool(x, `${path}.audio.lowLatency`)),
      bufferFrames: unknown(a.bufferFrames, (x) => num(x, `${path}.audio.bufferFrames`, 0, 65536)),
      sampleRate: unknown(a.sampleRate, (x) => num(x, `${path}.audio.sampleRate`, 0, 768000)),
      output: opt(a.output, (x) => oneOf(x, `${path}.audio.output`, LINKS)),
    },
    peripherals: per && per.map((p, i) => peripheral(p, `${path}.peripherals[${i}]`)),
    profile: oneOf(v.profile, `${path}.profile`, ['full', 'balanced', 'lightweight', 'minimal']),
    eco: bool(v.eco, `${path}.eco`),
  };
}

function stress(v, path) {
  if (v === null || v === undefined) return null;
  v = obj(v, path);
  const t = obj(v.tiers, `${path}.tiers`);
  const l = obj(v.limits, `${path}.limits`);
  const scenarios = {};
  for (const [k, s] of Object.entries(obj(v.scenarios, `${path}.scenarios`)).slice(0, 40)) {
    if (!ID.test(k)) continue;
    const p = `${path}.scenarios.${k}`;
    obj(s, p);
    scenarios[k] = {
      meanPct: num(s.meanPct, `${p}.meanPct`, 0, 10000),
      p99Pct: num(s.p99Pct, `${p}.p99Pct`, 0, 10000),
      worstPct: num(s.worstPct, `${p}.worstPct`, 0, 10000),
      dropouts: num(s.dropouts, `${p}.dropouts`, 0, 1e6),
    };
  }
  const costs = Array.isArray(v.topCosts) ? v.topCosts.slice(0, 10) : fail(`${path}.topCosts`, 'expected a list');
  return {
    version: num(v.version, `${path}.version`, 1, 1),
    tiers: {
      normal: oneOf(t.normal, `${path}.tiers.normal`, TIERS),
      heavy: oneOf(t.heavy, `${path}.tiers.heavy`, TIERS),
      extreme: oneOf(t.extreme, `${path}.tiers.extreme`, TIERS),
    },
    limits: {
      tracks: num(l.tracks, `${path}.limits.tracks`, 0, 100000),
      voices: num(l.voices, `${path}.limits.voices`, 0, 100000),
      effects: num(l.effects, `${path}.limits.effects`, 0, 100000),
    },
    scenarios,
    topCosts: costs.map((c, i) => {
      obj(c, `${path}.topCosts[${i}]`);
      return {
        component: typeof c.component === 'string' && BUILTIN.test(c.component) ? c.component : 'other',
        pct: num(c.pct, `${path}.topCosts[${i}].pct`, 0, 100),
      };
    }),
  };
}

function errors(v, path) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(path, 'expected a list');
  return v.slice(0, 20).map((e, i) => {
    obj(e, `${path}[${i}]`);
    return {
      type: str(e.type, `${path}[${i}].type`, 80, /^[A-Za-z_][A-Za-z0-9_.<>]*$/),
      where: str(e.where, `${path}[${i}].where`, 120, SOURCE),
      count: num(e.count, `${path}[${i}].count`, 0, 1e6),
    };
  });
}

// C.A.W's own source files, relative to its repo (never an absolute or user path).
const SOURCE = /^(?:(?:lib|src|engine|app|platform|include)\/|package:caw[a-z_]*\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,100}:[0-9]{1,6}$/;

const BUCKETS = { tracks: ['1-4', '5-8', '9-16', '17-32', '33+'], clips: ['1-10', '11-50', '51-200', '201+'] };

export function cleanReport(v) {
  v = obj(v, 'report');
  num(v.schema, 'schema', 1, 1);
  const app = obj(v.app, 'app');
  const perf = obj(v.perf, 'perf');
  const frames = obj(perf.frames, 'perf.frames');
  const usage = obj(v.usage, 'usage');
  const size = obj(usage.projectSize, 'usage.projectSize');
  const hist = perf.cpuLoadHistogram === undefined || perf.cpuLoadHistogram === null ? null
    : Array.isArray(perf.cpuLoadHistogram) && perf.cpuLoadHistogram.length === 10
      ? perf.cpuLoadHistogram : fail('perf.cpuLoadHistogram', 'expected 10 numbers');
  return {
    schema: 1,
    receipt: str(v.receipt, 'receipt', 32, RECEIPT),
    deleteHash: str(v.deleteHash, 'deleteHash', 64, HASH),
    channel: oneOf(v.channel, 'channel', ['beta', 'release']),
    // daily: the day's report; stress: one stress-test run (owner, 2026-11-12). Older reports without it are daily.
    kind: v.kind === undefined ? 'daily' : oneOf(v.kind, 'kind', ['daily', 'stress']),
    day: str(v.day, 'day', 10, /^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/),
    app: {
      version: str(app.version, 'app.version', 32, /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/),
      // Optional: the commit the build came from, so CI builds sharing one version number can be told apart.
      build: app.build === undefined ? undefined : str(app.build, 'app.build', 12, /^[0-9a-f]{7,12}$/),
      engineVersion: str(app.engineVersion, 'app.engineVersion', 32, /^[0-9A-Za-z.+-]+$/),
      capiVersion: num(app.capiVersion, 'app.capiVersion', 0, 100000),
    },
    device: device(v.device, 'device'),
    perf: {
      cpuLoadHistogram: hist && hist.map((x, i) => num(x, `perf.cpuLoadHistogram[${i}]`, 0, 1, 0.01)),
      dropouts: unknown(perf.dropouts, (x) => num(x, 'perf.dropouts', 0, 1e7)),
      worstCallbackPct: unknown(perf.worstCallbackPct, (x) => num(x, 'perf.worstCallbackPct', 0, 10000, 5)),
      frames: {
        p50ms: unknown(frames.p50ms, (x) => num(x, 'perf.frames.p50ms', 0, 10000, 0.1)),
        p99ms: unknown(frames.p99ms, (x) => num(x, 'perf.frames.p99ms', 0, 10000, 0.1)),
        slowPct: unknown(frames.slowPct, (x) => num(x, 'perf.frames.slowPct', 0, 100)),
      },
      startupMs: unknown(perf.startupMs, (x) => num(x, 'perf.startupMs', 0, 600000, 50)),
      thermalEvents: unknown(perf.thermalEvents, (x) => num(x, 'perf.thermalEvents', 0, 1e5)),
      batterySaverMinutes: unknown(perf.batterySaverMinutes, (x) => num(x, 'perf.batterySaverMinutes', 0, 1440)),
      schedHint: oneOf(perf.schedHint, 'perf.schedHint', ['on', 'off', 'unsupported']),
      callbackCoreType: oneOf(perf.callbackCoreType, 'perf.callbackCoreType', ['big', 'little', 'other', 'unknown']),
    },
    usage: {
      minutesOpen: num(usage.minutesOpen, 'usage.minutesOpen', 0, 1440, 5),
      minutesPlaying: num(usage.minutesPlaying, 'usage.minutesPlaying', 0, 1440, 5),
      screens: idMap(usage.screens, 'usage.screens', 1440, 5, ID),
      builtins: idMap(usage.builtins, 'usage.builtins', 1e6, 1, BUILTIN),
      projectSize: {
        tracks: oneOf(size.tracks, 'usage.projectSize.tracks', BUCKETS.tracks),
        clips: oneOf(size.clips, 'usage.projectSize.clips', BUCKETS.clips),
      },
    },
    stress: stress(v.stress, 'stress'),
    errors: errors(v.errors, 'errors'),
  };
}

const KINDS = ['bug', 'idea', 'confusing', 'praise'];
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export function cleanFeedback(v) {
  v = obj(v, 'feedback');
  num(v.schema, 'schema', 1, 1);
  const att = v.attachments === undefined ? {} : obj(v.attachments, 'attachments');
  const text = str(v.text, 'text', 5000).replace(/\r\n?/g, '\n');
  if (!text.trim()) fail('text', 'empty');
  return {
    kind: oneOf(v.kind, 'kind', KINDS),
    text,
    appVersion: str(v.appVersion, 'appVersion', 32, /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/),
    build: v.build === undefined ? undefined : str(v.build, 'build', 12, /^[0-9a-f]{7,12}$/),
    platform: oneOf(v.platform, 'platform', PLATFORMS),
    attachments: {
      device: att.device === undefined ? undefined : device(att.device, 'attachments.device'),
      stress: att.stress === undefined ? undefined : stress(att.stress, 'attachments.stress'),
      errors: att.errors === undefined ? undefined : errors(att.errors, 'attachments.errors'),
    },
    contact: v.contact === undefined || v.contact === '' ? undefined : str(v.contact, 'contact', 254, EMAIL),
  };
}
