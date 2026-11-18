#!/usr/bin/env node
// lazy-comfy.mjs — ComfyUI 按需启动 + 分级休眠 + 空闲自动关闭
//
// 监听 127.0.0.1:8189，把请求转发到内部 ComfyUI（默认 8188）。
// 三级策略（解决「每次都要等 50 秒冷启动」）：
//   1) 空闲 LAZY_IDLE_MIN 分钟 -> 调 /free 卸载模型腾显存（进程保留，唤醒只需重载模型）
//   2) 空闲 LAZY_STOP_MIN 分钟 -> 结束由本代理启动的后端进程
//   3) 后端中途退出 -> 看门狗带退避自动重启，不用等下一次请求才发现
//
// 请求分级（关键）：
//   - 被动探测（GET /prompt、GET /queue、GET /history/*、GET /models、GET /embeddings）
//     只读状态、不产生工作 -> 不记活跃、不唤醒后端。ComfyUI 网页断线后的 1s 轮询、
//     以及页面每 300ms 一次的 ws 重连都属于这一类。
//   - 主动请求（POST /prompt 出图、POST /interrupt、GET /view、加载页面等）
//     -> 记活跃 + 唤醒后端。
//   这样网页开着挂机不会被轮询续命，真正发图时立刻唤醒。
//
// 安全：只监听 127.0.0.1。ComfyUI 工作流可以执行本机代码，不要把端口暴露到公网。
//
// 兼容：Windows（含 ComfyUI 便携包的 python_embeded）、Linux、macOS；Node.js >= 20（18 已 EOL，未在 CI 覆盖）。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.1.8';

// 版本号的权威来源是 package.json；单文件部署时可能没有它，所以这里只做运行期校验。
// （不要把 VERSION 改成从 package.json 读取：很多人是单独拷 lazy-comfy.mjs 用。）
export function readPackageVersion(file = null) {
  try {
    const p = file || path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
  } catch {
    return null;
  }
}

const IS_WIN = process.platform === 'win32';
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// 结束后端连续失败时的退避上限。
const STOP_RETRY_MAX_MS = 5 * 60 * 1000;
// 被动探测（/system_stats）最多每这么多毫秒拉起一次后端，避免监控轮询把机器反复烫起来。
const PASSIVE_WAKE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** 杀不掉后端时的重试间隔：30s 起，翻倍，封顶 STOP_RETRY_MAX_MS。 */
export function stopBackoffMs(failures) {
  const n = Math.max(1, Math.floor(failures || 1));
  return Math.min(STOP_RETRY_MAX_MS, 30_000 * 2 ** Math.min(n - 1, 4));
}

/** 被动探测是否允许拉起后端（防止监控轮询反复冷启动）。 */
export function passiveWakeAllowed({ state, lastWakeAt, now = Date.now() }) {
  if (state !== 'stopped') return true;
  return now - (lastWakeAt || 0) >= PASSIVE_WAKE_MIN_INTERVAL_MS;
}

// 逐跳头不应该原样转发，交给 Node 自己重新生成。
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 被动探测：只读状态，不代表有人要出图。
// 路由匹配前会先去掉新版前端的 /api 前缀。
export const DEFAULT_PASSIVE_PATHS = [
  /^\/prompt$/,
  /^\/queue$/,
  /^\/history(?:\/.*)?$/,
  /^\/models$/,
  /^\/embeddings$/,
];

const STATS_STUB = {
  system: {
    os: IS_WIN ? 'nt' : process.platform,
    comfyui_version: 'starting',
    python_version: 'starting',
    pytorch_version: '',
  },
  devices: [{ name: 'starting', type: 'cuda', index: 0, vram_total: 0, vram_free: 0 }],
};

export class ConfigError extends Error {}

export const HELP = `lazy-comfy ${VERSION} — ComfyUI 按需启动 + 分级休眠代理

用法:
  node lazy-comfy.mjs [选项]

选项:
  -p, --port <端口>           代理监听端口（默认 8189，env LAZY_PORT）
  -b, --backend <端口>        ComfyUI 后端端口（默认 8188，env COMFY_PORT）
  -r, --root <目录>           ComfyUI 根目录（默认自动查找，env COMFY_ROOT）
      --python <路径>         Python 解释器（默认自动查找 venv / python_embeded）
      --idle <分钟>           空闲多久卸载模型（默认 10，0 = 关闭，env LAZY_IDLE_MIN）
      --stop <分钟>           空闲多久结束后端（默认 30，0 = 关闭，env LAZY_STOP_MIN）
      --log <文件>            日志文件（默认 <state-dir>/lazy.log，env LAZY_LOG）
      --state-dir <目录>      PID / 日志目录（默认 ~/.lazy-comfy，env LAZY_STATE_DIR）
      --start-timeout <毫秒>  冷启动超时（默认 180000，env LAZY_START_TIMEOUT_MS）
      --wait-timeout <毫秒>   请求等待后端就绪的上限（默认比启动超时多 10s，env LAZY_WAIT_TIMEOUT_MS）
      --upstream-timeout <毫秒> 单个转发的静默超时（默认 600000，0 = 关闭该超时，env LAZY_UPSTREAM_TIMEOUT_MS）
      --request-timeout <毫秒> 单请求无数据往来的兜底（默认 7200000，只在 --upstream-timeout 0 时生效，0 = 关闭，env LAZY_REQUEST_TIMEOUT_MS）
      --check-interval <毫秒> 空闲检查间隔（默认 30000，env LAZY_CHECK_MS）
      --hibernate-retry <次数> /free 连续失败多少次后放弃休眠（默认 3，env LAZY_HIBERNATE_RETRY）
      --probe-fail-limit <次数> 探活连续失败多少次后强制重启（默认 0=关闭，env LAZY_PROBE_FAIL_LIMIT）
      --passive-extra <正则>  追加被动路由正则，可重复（env LAZY_PASSIVE_EXTRA，逗号分隔）
      --stop-on-exit          代理退出时同时结束后端（默认保留，下次免冷启动）
      --debug                 打印每个请求（env LAZY_DEBUG=1）
  -h, --help                  显示帮助
  -v, --version               显示版本

示例:
  node lazy-comfy.mjs --root "D:\\ComfyUI"
  node lazy-comfy.mjs --idle 5 --stop 20 --stop-on-exit

Windows 便携包：--root 指向 ...\\ComfyUI_windows_portable\\ComfyUI，
代理会自动使用旁边的 python_embeded\\python.exe。

只监听 127.0.0.1；ComfyUI 工作流可执行本机代码，请勿暴露到公网。
`;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truthy(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

function numberOption(value, fallback, { label, min = 0, max = Number.POSITIVE_INFINITY, integer = false }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const range = max === Number.POSITIVE_INFINITY ? `需 ≥ ${min}` : `需在 ${min}-${max} 之间`;
    throw new ConfigError(`${label}无效: ${value}（${range}）`);
  }
  return n;
}

export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        backend: { type: 'string', short: 'b' },
        root: { type: 'string', short: 'r' },
        python: { type: 'string' },
        idle: { type: 'string' },
        stop: { type: 'string' },
        log: { type: 'string' },
        'state-dir': { type: 'string' },
        'start-timeout': { type: 'string' },
        'wait-timeout': { type: 'string' },
        'upstream-timeout': { type: 'string' },
        'request-timeout': { type: 'string' },
        'check-interval': { type: 'string' },
        'hibernate-retry': { type: 'string' },
        'probe-fail-limit': { type: 'string' },
        'passive-extra': { type: 'string', multiple: true },
        'stop-on-exit': { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    throw new ConfigError(err.message);
  }

  if (parsed.positionals.length) {
    throw new ConfigError(`无法识别的参数: ${parsed.positionals.join(' ')}`);
  }

  const v = parsed.values;
  if (v.help) return { help: true };
  if (v.version) return { version: true };

  const listenPort = numberOption(v.port ?? env.LAZY_PORT, 8189, {
    label: '代理端口', min: 1, max: 65535, integer: true,
  });
  const backendPort = numberOption(v.backend ?? env.COMFY_PORT, 8188, {
    label: '后端端口', min: 1, max: 65535, integer: true,
  });
  if (listenPort === backendPort) {
    throw new ConfigError('代理端口不能和后端端口相同（否则会自己转发给自己）');
  }

  const idleMin = numberOption(v.idle ?? env.LAZY_IDLE_MIN, 10, {
    label: '空闲卸载时间', min: 0,
  });
  const stopMin = numberOption(v.stop ?? env.LAZY_STOP_MIN, 30, {
    label: '空闲关闭时间', min: 0,
  });
  const startTimeoutMs = numberOption(v['start-timeout'] ?? env.LAZY_START_TIMEOUT_MS, 180_000, {
    label: '冷启动超时', min: 1_000,
  });
  const waitTimeoutMs = numberOption(v['wait-timeout'] ?? env.LAZY_WAIT_TIMEOUT_MS, startTimeoutMs + 10_000, {
    label: '请求等待超时', min: 1_000,
  });
  const upstreamTimeoutMs = numberOption(v['upstream-timeout'] ?? env.LAZY_UPSTREAM_TIMEOUT_MS, 600_000, {
    label: '上游请求超时', min: 0,
  });
  // 单请求兜底：只在上游静默超时被关掉（--upstream-timeout 0）时才生效。
  // 计时看「多久没有数据往来」，所以慢速但在传输的请求不会被误杀。
  const requestTimeoutMs = numberOption(v['request-timeout'] ?? env.LAZY_REQUEST_TIMEOUT_MS, 7_200_000, {
    label: '单请求兜底超时', min: 0,
  });
  const checkIntervalMs = numberOption(v['check-interval'] ?? env.LAZY_CHECK_MS, 30_000, {
    label: '检查间隔', min: 100,
  });
  const hibernateRetry = numberOption(v['hibernate-retry'] ?? env.LAZY_HIBERNATE_RETRY, 3, {
    label: '休眠失败重试次数', min: 1, max: 20, integer: true,
  });
  const probeFailLimit = numberOption(v['probe-fail-limit'] ?? env.LAZY_PROBE_FAIL_LIMIT, 0, {
    label: '探活强制重启阈值', min: 0, max: 20, integer: true,
  });

  const rawPassive = [...(v['passive-extra'] || [])];
  if (env.LAZY_PASSIVE_EXTRA) rawPassive.push(...String(env.LAZY_PASSIVE_EXTRA).split(','));
  const passiveExtra = [];
  for (const pattern of rawPassive.map((s) => s.trim()).filter(Boolean)) {
    try {
      passiveExtra.push(new RegExp(pattern));
    } catch {
      throw new ConfigError(`被动路由正则无效: ${pattern}`);
    }
  }

  return {
    help: false,
    version: false,
    listenPort,
    backendPort,
    root: clean(v.root) ?? clean(env.COMFY_ROOT),
    python: clean(v.python) ?? clean(env.COMFY_PYTHON) ?? clean(env.LAZY_PYTHON),
    idleMin,
    stopMin,
    logFile: clean(v.log) ?? clean(env.LAZY_LOG),
    stateDir: clean(v['state-dir']) ?? clean(env.LAZY_STATE_DIR),
    startTimeoutMs,
    waitTimeoutMs,
    upstreamTimeoutMs,
    requestTimeoutMs,
    checkIntervalMs,
    hibernateRetry,
    probeFailLimit,
    stopOnExit: Boolean(v['stop-on-exit']) || truthy(env.LAZY_STOP_ON_EXIT),
    debug: Boolean(v.debug) || truthy(env.LAZY_DEBUG),
    passiveExtra,
  };
}

// ---------------------------------------------------------------------------
// 路由分类
// ---------------------------------------------------------------------------

/** 去掉新版 ComfyUI 前端的 /api 前缀，其它路径原样返回。 */
export function normalizePath(pathname) {
  const p = String(pathname || '/');
  if (p === '/api') return '/';
  return p.startsWith('/api/') ? p.slice(4) : p;
}

/**
 * 是否是「被动探测」。
 * 只有 GET 才可能被动；POST /prompt、POST /interrupt 等一律算主动。
 * @param {string} method
 * @param {string} url 可带 query
 * @param {RegExp[]} extra 额外被动正则
 */
export function isPassive(method, url, extra = []) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  const pathname = normalizePath(String(url || '/').split('?')[0] || '/');
  return DEFAULT_PASSIVE_PATHS.some((re) => re.test(pathname))
    || extra.some((re) => re.test(pathname));
}

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------

const S = {
  state: 'stopped', // stopped | starting | running | stopping
  managed: false,   // 后端是否由本代理启动（决定空闲时敢不敢杀）
  pid: null,
  startPromise: null,
  stopPromise: null,
  startChild: null,
  startStartedAt: 0,
  lastStartError: '',
  nextStartAt: 0,
  failures: 0,
  healthyTimer: null,
  hibernatedAt: 0,
  hibernationUnsupported: false,
  hibernateFailures: 0,
  probeFailures: 0,
  externalStopNotified: false,
  lastActivity: Date.now(),
  activeInFlight: 0,
  activeSince: 0,      // 从 0 变成 >0 的时间，只用于「挂太久」提示日志
  stuckWarnAt: 0,      // 下次允许打印「挂太久」提示的时间
  busyWarnAt: 0,       // 下次允许打印「队列里还有任务」提示的时间
  pidState: null,      // PID 文件里记的状态：starting / running
  stopFailures: 0,     // 结束后端连续失败次数
  stopRetryAt: 0,      // 结束失败后的退避截止时间，未到点不再重试杀进程
  lastPassiveWakeAt: 0, // 上次因被动探测而拉起后端的时间
  ticking: false,
  shuttingDown: false,
  sockets: new Set(),
  timer: null,
  spawnError: null,
};

let cfg = null;
let logger = null;
let server = null;
let upstreamAgent = null;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise.catch(() => false);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 路径发现
// ---------------------------------------------------------------------------

function resolveRoot(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!fileExists(path.join(dir, 'main.py'))) {
      throw new Error(`指定的 ComfyUI 目录里没有 main.py: ${dir}`);
    }
    return dir;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const home = os.homedir();
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), 'ComfyUI'),
    here,
    path.join(here, 'ComfyUI'),
    path.join(home, 'ComfyUI'),
    path.join(home, 'Documents', 'ComfyUI'),
    path.join(home, 'Desktop', 'ComfyUI'),
  ];
  if (IS_WIN) candidates.push('D:\\ComfyUI', 'C:\\ComfyUI');
  else candidates.push('/opt/ComfyUI', '/usr/local/ComfyUI');

  const unique = [...new Set(candidates.map((item) => path.resolve(item)))];
  for (const candidate of unique) {
    if (fileExists(path.join(candidate, 'main.py'))) return candidate;
  }
  throw new Error(`没有自动找到 ComfyUI，请用 --root 或 COMFY_ROOT 指定。已尝试:\n  ${unique.join('\n  ')}`);
}

function resolvePython(root, explicit) {
  if (explicit) {
    const looksLikePath = path.isAbsolute(explicit) || explicit.includes('/') || explicit.includes('\\');
    if (looksLikePath) {
      const resolved = path.resolve(explicit);
      if (!fileExists(resolved)) {
        throw new Error(`Python 解释器不存在: ${resolved}`);
      }
      return resolved;
    }
    return explicit;
  }

  const candidates = IS_WIN
    ? [
        path.join(root, '.venv', 'Scripts', 'python.exe'),
        path.join(root, 'venv', 'Scripts', 'python.exe'),
        path.join(root, '..', 'python_embeded', 'python.exe'),
        path.join(root, 'python_embeded', 'python.exe'),
      ]
    : [
        path.join(root, '.venv', 'bin', 'python'),
        path.join(root, 'venv', 'bin', 'python'),
      ];

  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  // 交给 PATH；如果不存在，spawn 时会给出明确错误。
  return IS_WIN ? 'python' : 'python3';
}

function resolveStateDir(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const preferred = path.join(os.homedir(), '.lazy-comfy');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'lazy-comfy');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function createLogger({ file, debug }) {
  let fileOk = false;
  let writes = 0;
  let fileFailures = 0;

  function tryOpen() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, '');
      return true;
    } catch {
      return false;
    }
  }

  fileOk = tryOpen();

  function rotate() {
    try {
      if (fs.statSync(file).size < MAX_LOG_BYTES) return;
      // 后端进程持有同一个日志 fd，用 copy + truncate，避免它继续写进 .1 文件。
      fs.copyFileSync(file, `${file}.1`);
      fs.truncateSync(file, 0);
    } catch {
      // 日志轮转失败不影响主流程
    }
  }

  function write(line) {
    writes += 1;
    // 文件日志写失败（杀毒软件锁、磁盘满）后不再永久放弃：每 50 行重开一次。
    if (!fileOk && writes % 50 === 0 && tryOpen()) {
      fileOk = true;
      fileFailures = 0;
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} 文件日志已恢复写入\n`, 'utf8');
      } catch {
        fileOk = false;
      }
    }
    if (fileOk) {
      try {
        if (writes % 50 === 0) rotate();
        fs.appendFileSync(file, line, 'utf8');
      } catch {
        fileOk = false;
        fileFailures += 1;
        if (fileFailures === 1) {
          try {
            process.stdout.write(`${new Date().toISOString()} 写日志文件失败，稍后自动重试（详见 stderr/stdout）\n`);
          } catch {
            // ignore
          }
        }
      }
    }
    try {
      process.stdout.write(line);
    } catch {
      // 服务方式运行时 stdout 可能已关闭
    }
  }

  try {
    process.stdout.on('error', () => {});
  } catch {
    // ignore
  }

  return {
    file,
    get fileOk() {
      return fileOk;
    },
    maybeRotate() {
      rotate();
    },
    info(message) {
      write(`${new Date().toISOString()} ${message}\n`);
    },
    debug(message) {
      if (debug) write(`${new Date().toISOString()} DEBUG ${message}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// PID 文件 / 进程识别
// ---------------------------------------------------------------------------

function writePidFile(state = S.pidState || 'running') {
  try {
    const data = JSON.stringify({
      pid: S.pid,
      port: cfg.backendPort,
      root: cfg.root,
      state,
      startedAt: new Date().toISOString(),
    });
    const tmp = `${cfg.pidFile}.tmp`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, cfg.pidFile);
  } catch (err) {
    logger.info(`写 PID 文件失败: ${err.message}`);
  }
}

function readPidFile() {
  try {
    return JSON.parse(fs.readFileSync(cfg.pidFile, 'utf8'));
  } catch {
    return null;
  }
}

function clearPidFile() {
  try {
    fs.unlinkSync(cfg.pidFile);
  } catch {
    // 不存在就算了
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function run(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(-1);
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(-1);
    }, timeoutMs);
    timer.unref?.();
    child.once('error', () => finish(-1));
    child.once('exit', (code) => finish(code ?? -1));
  });
}

function capture(cmd, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish();
    }, timeoutMs);
    timer.unref?.();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out.trim());
    };
    child.stdout?.on('data', (chunk) => {
      if (out.length < 1_000_000) out += chunk;
    });
    child.once('error', finish);
    child.once('exit', finish);
  });
}

async function commandLine(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      return '';
    }
  }
  if (IS_WIN) {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
    // 15 秒：CI 的 2 核 runner 上 powershell 冷启动 + CIM 首次加载 2~4 秒是常态，
    // 并发跑满时更久；5 秒会直接超时返回空字符串，让 looksLikeComfy 误判成「不是我的后端」。
    return capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
  }
  return capture('ps', ['-p', String(pid), '-o', 'command=']);
}

/** 后端入口脚本名。默认 main.py；LAZY_ENTRY 仅供测试把入口换成 main.cjs。 */
function backendEntry() {
  return process.env.LAZY_ENTRY || 'main.py';
}
/** 确认 PID 真的是「从 root 启动、监听 backendPort 的 main.py」，避免误杀。 */
async function looksLikeComfy(pid, root, port) {
  const cmd = await commandLine(pid);
  if (!cmd) return false;
  const normalized = cmd.replace(/\\/g, '/').toLowerCase();
  if (!normalized.includes(backendEntry().toLowerCase())) return false;
  if (!new RegExp(`--port(?:\\s+|=)${port}(?:\\s|$)`).test(normalized)) return false;

  if (process.platform === 'linux') {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      return path.resolve(cwd) === path.resolve(root);
    } catch {
      // 读不到 cwd 时退回命令匹配
    }
  }
  return true;
}

/** 轮询等待进程退出；返回它是否真的没了。 */
async function waitForExit(pid, tries = 10, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    if (!isAlive(pid)) return true;
    await sleep(delayMs);
  }
  return !isAlive(pid);
}

/** 结束进程树：Windows 用 taskkill /T，POSIX 杀整个进程组。 */
async function stopProcessTree(pid) {
  if (!isAlive(pid)) return true;

  if (IS_WIN) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await run('taskkill', ['/PID', String(pid), '/T', '/F']);
      if (await waitForExit(pid)) return true;
      if (attempt === 1) logger?.info(`taskkill 后进程 ${pid} 仍在，重试一次`);
    }
    // taskkill 不在 PATH / 被杀软拦下时的兜底：只杀主进程（子孙可能要手动清理），
    // 总比留下一个占着 7GB 显存的 python 好。
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return false;
    }
    logger?.info(`taskkill 未生效，退回 process.kill(${pid})（子孙进程可能残留）`);
    return waitForExit(pid);
  }

  const signal = (sig) => {
    try {
      process.kill(-pid, sig); // detached 启动，pid 就是进程组组长
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (!signal('SIGTERM')) {
    // 可能已经退出但还没被回收
    return waitForExit(pid, 5, 100);
  }
  if (await waitForExit(pid, 25, 200)) return true;
  signal('SIGKILL');
  await sleep(200);
  return !isAlive(pid);
}

// ---------------------------------------------------------------------------
// 后端探测 / 休眠
// ---------------------------------------------------------------------------

function probe(timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get({
        host: '127.0.0.1',
        port: cfg.backendPort,
        path: '/system_stats',
        timeout: timeoutMs,
        agent: false,
      }, (res) => {
        res.resume();
        res.on('end', () => finish(res.statusCode === 200));
        res.on('error', () => finish(false));
      });
    } catch {
      finish(false);
      return;
    }
    req.on('error', () => finish(false));
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
  });
}

/**
 * 问后端一句：队列里还有活吗？
 *
 * 出图期间的流量只有 ws 进度推送和被动轮询（/queue、/history），两者都不更新
 * lastActivity，所以「用户正在出图」这件事对看门狗完全不可见。休眠模型 / 结束进程
 * 之前必须直接问后端 —— /queue 是权威信号，ws 会被 Crystools 这类周期性推送骗到。
 *
 * 返回值是三态，故意不用布尔：
 *   'busy'    —— queue_running 或 queue_pending 非空（批量任务排队时 running 可能是空的）
 *   'idle'    —— 确实没有活，可以按空闲策略处理
 *   'unknown' —— 请求失败 / 超时 / 响应看不懂：应当保守跳过本轮，不能当成「可以杀」
 */
function backendQueueState(timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get({
        host: '127.0.0.1',
        port: cfg.backendPort,
        path: '/queue',
        timeout: timeoutMs,
        agent: false,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish('unknown');
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (buf.length < 256 * 1024) buf += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(buf);
            const count = (key) => (Array.isArray(json[key]) ? json[key].length : 0);
            finish(count('queue_running') + count('queue_pending') > 0 ? 'busy' : 'idle');
          } catch {
            finish('unknown');
          }
        });
        res.on('error', () => finish('unknown'));
      });
      req.on('error', () => finish('unknown'));
      req.on('timeout', () => {
        req.destroy();
        finish('unknown');
      });
    } catch {
      finish('unknown');
    }
  });
}

function postFree(pathname) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ unload_models: true, free_memory: true });
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port: cfg.backendPort,
        path: pathname,
        method: 'POST',
        timeout: 15_000,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
        res.on('error', () => resolve(0));
      });
    } catch {
      resolve(0);
      return;
    }
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.end(body);
  });
}

/**
 * 让 ComfyUI 自己卸掉模型；新旧版本分别尝试 /free 与 /api/free。
 * 返回 HTTP 状态码（0 = 超时/网络错误），由调用方区分「明确不支持」和「临时失败」。
 */
async function hibernateBackend() {
  let code = await postFree('/free');
  if (code === 404 || code === 405) code = await postFree('/api/free');
  return { ok: code === 200, code };
}

// ---------------------------------------------------------------------------
// 后端生命周期
// ---------------------------------------------------------------------------

function spawnBackend() {
  // LAZY_ENTRY 只给测试用（默认就是 main.py）：把「入口文件名」和「解释器」解耦，
  // 测试就能拿 node 跑一个 main.cjs，不再依赖 Node 对未知扩展名的处理方式。
  const entry = backendEntry();
  const args = [
    entry,
    '--listen', '127.0.0.1',
    '--port', String(cfg.backendPort),
    '--disable-auto-launch',
  ];

  let stdio = 'ignore';
  try {
    const fd = fs.openSync(logger.file, 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    // 日志文件不可写时仍然启动，只是收不到后端输出
  }

  let child;
  try {
    child = spawn(cfg.python, args, {
      cwd: cfg.root,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      detached: true, // 独立进程组：代理重启/退出时后端不会被一起带走
      windowsHide: true,
      stdio,
    });
  } finally {
    if (Array.isArray(stdio)) {
      try {
        fs.closeSync(stdio[1]);
      } catch {
        // ignore
      }
    }
  }

  child.on('error', (err) => {
    S.spawnError = err;
  });
  child.unref();
  return child;
}

function scheduleRetry() {
  S.failures += 1;
  const delay = Math.min(60_000, 5_000 * 2 ** Math.min(S.failures - 1, 4));
  S.nextStartAt = Date.now() + delay;
  return delay;
}

function scheduleHealthyReset() {
  if (S.healthyTimer) clearTimeout(S.healthyTimer);
  S.healthyTimer = setTimeout(() => {
    S.failures = 0;
  }, 5 * 60_000);
  S.healthyTimer.unref?.();
}

function markRunning(pid, { managed, how }) {
  const elapsed = S.startStartedAt ? Math.round((Date.now() - S.startStartedAt) / 1000) : 0;
  S.state = 'running';
  S.startChild = null;
  S.hibernatedAt = 0;
  S.hibernationUnsupported = false;
  S.hibernateFailures = 0;
  S.probeFailures = 0;
  S.externalStopNotified = false;
  S.lastStartError = '';
  S.lastActivity = Date.now();
  S.stopFailures = 0;
  S.stopRetryAt = 0;
  S.managed = Boolean(managed && Number.isInteger(pid));
  S.pid = S.managed ? pid : null;

  S.pidState = S.managed ? (how === 'adopt-starting' ? 'starting' : 'running') : null;
  // 接管来的「启动中后端」要重新计时：它可能永远不 ready，
  // 不设 deadline 就会一直停在 starting（不发空闲策略、也没有启动超时）。
  if (how === 'adopt-starting') S.startStartedAt = Date.now();
  if (S.managed) writePidFile();
  else clearPidFile();

  if (how === 'spawn') logger.info(`后端已就绪（pid ${pid}，用时 ${elapsed}s）`);
  else if (how === 'adopt') logger.info(`复用上次启动的后端（pid ${pid}）`);
  else if (how === 'adopt-starting') logger.info(`接管上次没启动完的后端（pid ${pid}），就绪前一概不动它`);
  else logger.info('发现已在运行的后端（不是本代理启动的：空闲时只休眠，不结束进程）');

  scheduleHealthyReset();
}

function failStart(reason) {
  if (S.state !== 'starting') return;
  S.state = 'stopped';
  S.startChild = null;
  S.managed = false;
  S.pid = null;
  S.lastStartError = reason;
  clearPidFile();
  const delay = scheduleRetry();
  logger.info(`后端启动失败: ${reason}（${Math.round(delay / 1000)}s 后重试）`);
}

async function abortStart(reason, expectedState = 'starting') {
  if (S.state !== expectedState) return;
  // 接管来的「启动中后端」没有 startChild，只能靠 S.pid；漏了它就会重新变成孤儿。
  const pid = S.startChild?.pid ?? S.pid ?? null;
  // 先改状态，让 startBackend 的轮询尽快退出
  S.state = 'stopped';
  S.startChild = null;
  S.lastStartError = reason;
  const delay = scheduleRetry();
  logger.info(`启动超时: ${reason}（${Math.round(delay / 1000)}s 后重试）`);

  if (!pid) {
    S.managed = false;
    S.pid = null;
    clearPidFile();
    return;
  }

  // 先按「托管中」记账，杀干净了才放手。否则半启动的 Python 会变成孤儿：
  // 下个 probe 把它当外部后端，从此永远不会被空闲策略结束（HANDOFF §8.1 同类问题）。
  S.managed = true;
  S.pid = pid;
  writePidFile();
  const ok = await stopProcessTree(pid);
  if (ok || !isAlive(pid)) {
    S.managed = false;
    S.pid = null;
    clearPidFile();
    if (ok) logger.info(`启动超时后已结束半启动的进程（pid ${pid}）`);
    return;
  }
  // 杀不掉就接管它：状态回到 running，让空闲/健康检查继续负责重试，绝不留孤儿。
  S.stopFailures += 1;
  S.stopRetryAt = Date.now() + stopBackoffMs(1);
  S.state = 'running';
  S.hibernatedAt = 0;
  S.lastActivity = Date.now();
  logger.info(
    `启动超时后无法结束进程（pid ${pid} 仍在）；已接管为托管后端，空闲策略会继续重试（第 ${S.stopFailures} 次）`,
  );
}

async function startBackend(reason) {
  S.lastStartError = '';
  S.spawnError = null;

  // 可能后端已经在跑（外部启动 / 上次没杀干净），先认领，避免起第二个实例。
  if (await probe(1_000)) {
    if (S.state !== 'starting') return false;
    markRunning(null, { managed: false, how: 'external' });
    return true;
  }

  logger.info(`后端未运行（${reason}），开始启动: ${cfg.python}`);
  const t0 = Date.now();
  let child;
  try {
    child = spawnBackend();
  } catch (err) {
    failStart(`无法启动 Python: ${err.message}`);
    return false;
  }
  if (!child.pid) {
    await sleep(50);
    failStart(S.spawnError ? `无法启动 Python: ${S.spawnError.message}` : '无法创建后端进程');
    return false;
  }
  S.startChild = child;
  // 冷启动要 40–60 秒。这期间代理要是被杀掉，下次启动就认不出这个后端是自己的，
  // 会把它当「外部后端」（之后 --stop 永远不敢动它）。所以先把 pid 落盘。
  S.pid = child.pid;
  S.managed = true;
  S.pidState = 'starting';
  writePidFile('starting');
  let nextNote = t0 + 15_000;

  while (S.state === 'starting') {
    if (S.spawnError) {
      failStart(`无法启动 Python: ${S.spawnError.message}`);
      return false;
    }
    if (child.exitCode !== null || child.signalCode) {
      failStart(`进程提前退出（code=${child.exitCode}, signal=${child.signalCode}）`);
      return false;
    }
    if (await probe(1_000)) {
      if (S.state !== 'starting') return false;
      markRunning(child.pid, { managed: true, how: 'spawn' });
      return true;
    }
    if (Date.now() >= nextNote) {
      logger.info(`后端仍在启动…（${Math.round((Date.now() - t0) / 1000)}s）`);
      nextNote = Date.now() + 15_000;
    }
    await sleep(1_000);
  }
  return false;
}

function ensureBackend(reason = 'request') {
  if (S.state === 'running') return Promise.resolve(true);
  if (S.startPromise) return S.startPromise;
  if (S.stopPromise) return S.stopPromise.then(() => ensureBackend(reason));
  if (Date.now() < S.nextStartAt) return Promise.resolve(false);

  S.state = 'starting';
  S.startStartedAt = Date.now();
  S.startPromise = startBackend(reason)
    .catch((err) => {
      logger.info(`启动流程异常: ${err?.stack || err}`);
      failStart(err?.message || String(err));
      return false;
    })
    .finally(() => {
      S.startPromise = null;
    });
  return S.startPromise;
}

/** 统一把状态切到「已停止」：pid / 托管标记 / 休眠时间一起清，避免三处各写一遍。 */
function markStopped({ resetCounters = false, clearExternalNotify = false } = {}) {
  S.state = 'stopped';
  S.managed = false;
  S.pid = null;
  S.pidState = null;
  S.hibernatedAt = 0;
  if (clearExternalNotify) S.externalStopNotified = false;
  if (resetCounters) {
    S.nextStartAt = 0;
    S.failures = 0;
    S.probeFailures = 0;
  }
  clearPidFile();
}

async function onBackendGone(why) {
  if (S.state !== 'running') return;
  const wasManaged = S.managed;
  markStopped({ clearExternalNotify: true });
  upstreamAgent?.destroy();

  const delay = scheduleRetry();
  if (wasManaged && S.failures <= 5) {
    logger.info(`看门狗: 后端消失（${why}），${Math.round(delay / 1000)}s 后自动重启`);
    const timer = setTimeout(() => {
      ensureBackend('watchdog').catch(() => {});
    }, delay + 100);
    timer.unref?.();
  } else if (wasManaged) {
    logger.info(`看门狗: 后端消失（${why}），连续失败过多，暂停自动重启；下次主动请求会再试`);
  } else {
    logger.info(`看门狗: 外部启动的后端消失（${why}），等待下一次主动请求`);
  }
}

function stopBackend(reason) {
  if (S.stopPromise) return S.stopPromise;
  if (!S.managed || !S.pid) {
    if (reason.startsWith('空闲') && !S.externalStopNotified) {
      S.externalStopNotified = true;
      logger.info('空闲达到关闭阈值，但后端不是本代理启动的，跳过结束进程');
    }
    return Promise.resolve(false);
  }

  const pid = S.pid;
  S.state = 'stopping';
  S.stopPromise = (async () => {
    logger.info(`${reason} -> 结束后端进程（pid ${pid}）`);
    upstreamAgent?.destroy();
    const ok = await stopProcessTree(pid);
    if (!ok) {
      // 杀不掉时不能假装已停止：保留托管状态，退避后再试，否则后端会一直占着显存。
      S.stopFailures += 1;
      const backoff = stopBackoffMs(S.stopFailures);
      S.stopRetryAt = Date.now() + backoff;
      S.state = 'running';
      S.pid = pid;
      S.managed = true;
      const hint = S.stopFailures >= 3
        ? '；连续失败，请手动结束该进程或检查权限'
        : `；${Math.round(backoff / 1000)}s 后再试`;
      logger.info(`结束后端失败（pid ${pid} 仍在，第 ${S.stopFailures} 次）${hint}`);
      return false;
    }
    S.stopFailures = 0;
    S.stopRetryAt = 0;
    markStopped({ resetCounters: true });
    logger.info('后端已结束');
    return true;
  })()
    .catch((err) => {
      logger.info(`结束后端异常: ${err?.stack || err}`);
      // 异常也不能默认「已经停了」：进程还活着就继续托管并退避重试。
      if (isAlive(pid)) {
        S.stopFailures += 1;
        S.stopRetryAt = Date.now() + stopBackoffMs(S.stopFailures);
        S.state = 'running';
        S.pid = pid;
        S.managed = true;
        logger.info(`结束后端异常，但 pid ${pid} 仍在；保留托管状态，稍后重试`);
        return false;
      }
      markStopped();
      return false;
    })
    .finally(() => {
      S.stopPromise = null;
    });
  return S.stopPromise;
}

// ---------------------------------------------------------------------------
// 空闲看门狗
// ---------------------------------------------------------------------------

function idleMinutes() {
  return (Date.now() - S.lastActivity) / 60_000;
}

async function tick() {
  if (S.ticking || S.shuttingDown) return;
  if (S.activeInFlight > 0) {
    // 正在出图/下载，别动。但如果是挂死的请求（比如 --request-timeout 0 关掉了兜底），
    // 空闲策略会被无限期挡住 —— 这种情况至少要在日志里说清楚，别让用户猜。
    const held = S.activeSince ? Date.now() - S.activeSince : 0;
    if (held > 30 * 60_000 && Date.now() >= S.stuckWarnAt) {
      S.stuckWarnAt = Date.now() + 10 * 60_000;
      logger.info(
        `提示: 有 ${S.activeInFlight} 条主动请求已持续 ${Math.round(held / 60_000)} 分钟未结束，` +
          '空闲策略暂不生效；若是挂死的请求，靠 --request-timeout（默认 2 小时）兜底',
      );
    }
    return;
  }
  S.ticking = true;
  try {
    logger?.maybeRotate?.();
    if (S.state === 'running') {
      // 接管来的、一直没就绪的后端：它既不会被当成 starting（state 已是 running），
      // 也没有启动超时兜底，只会在 /queue 那里一直 unknown。这里补一个 deadline。
      // 退避期间不重试，和 stopBackend 的策略保持一致（杀不掉时别每 30 秒刷一条）。
      if (S.managed && S.pidState === 'starting' && cfg.startTimeoutMs > 0 && S.startStartedAt &&
          !(S.stopRetryAt && Date.now() < S.stopRetryAt) &&
          Date.now() - S.startStartedAt > cfg.startTimeoutMs) {
        await abortStart(`接管的启动中后端超过 ${Math.round(cfg.startTimeoutMs / 1000)}s 仍未就绪`, 'running');
        return;
      }
      const idle = idleMinutes();

      // 空闲虽然到点了，但后端可能还在跑任务：生成期间只有 ws 进度和被动轮询，
      // 都不会刷新 lastActivity，看门狗光看时间会误杀正在出图的进程。
      const idleHit = (cfg.stopMin > 0 && idle >= cfg.stopMin) || (cfg.idleMin > 0 && idle >= cfg.idleMin);
      if (idleHit) {
        const queue = await backendQueueState();
        // 'unknown' 有两种可能：后端活着但 /queue 出错（保守跳过），或者后端已经死了（必须交给看门狗）。
        // 不区分就会出问题：后端一死，/queue 永远失败，这里一直 return，看门狗再也发现不了它没了。
        const alive = queue === 'unknown' ? await probe(3_000) : true;
        if (queue === 'busy' || (queue === 'unknown' && alive)) {
          if (queue === 'busy') {
            // 队列里有活 = 后端在干活，重置空闲计时；否则队列刚清空的下一轮会立刻休眠/结束。
            S.lastActivity = Date.now();
          }
          if (Date.now() >= S.busyWarnAt) {
            S.busyWarnAt = Date.now() + 5 * 60_000;
            logger.info(queue === 'busy'
              ? '后端队列里还有任务在跑（/queue 非空），本轮先不卸载模型、不结束后端'
              : '/queue 检查失败（超时或 5xx），保守跳过本轮：不卸载模型、不结束后端');
          }
          return;
        }
        S.busyWarnAt = 0;
      }

      // 先按 stopMin 处理：即使探活失败、进程还活着，空闲到点也要结束。
      // 否则卡死的后端会一直停在「进程仍在，暂不重启」分支，--stop 永远不执行。
      if (cfg.stopMin > 0 && idle >= cfg.stopMin) {
        if (S.managed) {
          // 上一次杀进程失败就先退避，别每个检查周期都跑一遍 taskkill 刷日志。
          if (S.stopRetryAt && Date.now() < S.stopRetryAt) return;
          await stopBackend(`空闲 ${cfg.stopMin} 分钟`);
        } else if (!S.externalStopNotified) {
          S.externalStopNotified = true;
          logger.info('空闲达到关闭阈值，但后端不是本代理启动的，跳过结束进程');
        }
        return;
      }

      if (!(await probe())) {
        // 出图高峰时 /system_stats 偶尔会超过探活超时；进程还在就先不动，
        // 否则会把「自己启动的后端」降级成外部后端，之后就不敢按空闲策略杀了。
        if (S.managed && S.pid && isAlive(S.pid)) {
          S.probeFailures += 1;
          // 接管来的「启动中后端」还没就绪是正常状态，别每轮刷一条健康检查超时。
          if (S.pidState === 'starting') return;
          if (cfg.probeFailLimit > 0 && S.probeFailures >= cfg.probeFailLimit) {
            logger.info(`健康检查连续失败 ${S.probeFailures} 次，进程仍在但无响应，强制重启`);
            const stopped = await stopBackend('健康检查连续失败');
            S.probeFailures = 0;
            if (stopped) ensureBackend('watchdog').catch(() => {});
            return;
          }
          const progress = cfg.probeFailLimit > 0 ? `（${S.probeFailures}/${cfg.probeFailLimit}）` : '';
          logger.info(`健康检查超时${progress}，但后端进程仍在，暂不重启`);
          return;
        }
        S.probeFailures = 0;
        await onBackendGone('健康检查失败');
        return;
      }
      S.probeFailures = 0;
      if (S.managed && S.pidState === 'starting') {
        // 接管来的「启动中后端」此刻真的就绪了，PID 文件状态跟着升级。
        S.pidState = 'running';
        writePidFile('running');
      }

      if (cfg.idleMin > 0 && idle >= cfg.idleMin && !S.hibernatedAt && !S.hibernationUnsupported) {
        const result = await hibernateBackend();
        if (S.state !== 'running') return;
        if (result.ok) {
          S.hibernatedAt = Date.now();
          S.hibernateFailures = 0;
          logger.info(`空闲 ${cfg.idleMin} 分钟 -> 已卸载模型（进程保留）`);
        } else {
          S.hibernateFailures += 1;
          const code = result.code || 'timeout';
          const definitelyUnsupported = result.code === 404 || result.code === 405;
          if (definitelyUnsupported || S.hibernateFailures >= cfg.hibernateRetry) {
            // 不因为一次临时失败提前杀进程；等 stopMin 到点再按停止策略处理。
            S.hibernationUnsupported = true;
            const next = cfg.stopMin > 0
              ? `等空闲 ${cfg.stopMin} 分钟再结束后端`
              : '--stop 为 0，不会主动结束后端';
            logger.info(`卸载模型失败（HTTP ${code}），已连续 ${S.hibernateFailures} 次；不再尝试，${next}`);
          } else {
            logger.info(`卸载模型失败（HTTP ${code}），第 ${S.hibernateFailures}/${cfg.hibernateRetry} 次，下次检查再试`);
          }
        }
      }
      return;
    }

    if (S.state === 'stopped') {
      // 外部有人在别处启动了 ComfyUI：认领它，但不要接管生杀大权
      if (!S.startPromise && await probe()) {
        markRunning(null, { managed: false, how: 'external' });
      }
      return;
    }

    if (S.state === 'starting') {
      if (cfg.startTimeoutMs > 0 && Date.now() - S.startStartedAt > cfg.startTimeoutMs) {
        await abortStart(`冷启动超过 ${Math.round(cfg.startTimeoutMs / 1000)}s`);
      }
    }
  } finally {
    S.ticking = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP 转发
// ---------------------------------------------------------------------------

function buildRequestHeaders(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'expect') continue;
    out[lower] = value;
  }
  out.host = `127.0.0.1:${cfg.backendPort}`;
  return out;
}

function filterResponseHeaders(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function forward(req, res) {
  const watch = res[REQUEST_WATCH];
  let upstream;
  try {
    upstream = http.request({
      host: '127.0.0.1',
      port: cfg.backendPort,
      path: req.url,
      method: req.method,
      headers: buildRequestHeaders(req.headers),
      agent: upstreamAgent,
    }, (up) => {
      // 上游一有数据就说明这条请求还活着，兜底计时重置。
      if (watch?.bump) up.on('data', watch.bump);
      let headers;
      try {
        headers = filterResponseHeaders(up.headers);
        res.writeHead(up.statusCode || 502, headers);
      } catch (err) {
        logger.info(`回写响应头失败: ${err.message}`);
        up.destroy();
        res.destroy();
        return;
      }
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
  } catch (err) {
    logger.info(`转发失败 ${req.method} ${req.url}: ${err.message}`);
    sendJson(res, 502, { error: '无法连接 ComfyUI 后端', detail: err.message });
    return;
  }
  if (watch) watch.upstream = upstream;

  let timedOut = false;
  if (cfg.upstreamTimeoutMs > 0) {
    // 注意：这是「静默超时」——超过这么久没有任何数据往来才触发，不是请求总时长。
    upstream.setTimeout(cfg.upstreamTimeoutMs, () => {
      timedOut = true;
      logger.info(
        `转发超时 ${req.method} ${req.url}（${Math.round(cfg.upstreamTimeoutMs / 1000)}s 没有数据往来），` +
          `只断开本机这一侧；ComfyUI 里的任务不会被取消，仍会跑完`,
      );
      upstream.destroy();
      if (!res.headersSent) {
        sendJson(res, 504, {
          error: 'ComfyUI 后端响应超时',
          detail: `上游 ${cfg.upstreamTimeoutMs}ms 没有数据往来（可用 --upstream-timeout 调整）；后端任务本身不会被取消`,
        });
      } else {
        res.destroy();
      }
    });
  }

  upstream.on('error', (err) => {
    if (timedOut) return;
    if (res.destroyed || res.writableEnded) return;
    logger.info(`转发失败 ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: '无法连接 ComfyUI 后端', detail: err.message });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
  req.on('error', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  // pipe 先接管 body，再挂 'data' 才不会丢字节（见 armRequestWatch）。
  req.pipe(upstream);
  watch?.attachBody?.();
}

function handleUpgrade(req, socket, head) {
  socket.on('error', () => {});
  // 网页断线后每 300ms 重连一次 ws；后端睡着时不能让它把进程拉起来。
  if (S.state !== 'running') {
    socket.destroy();
    return;
  }

  const target = net.connect(cfg.backendPort, '127.0.0.1');
  target.once('connect', () => {
    const lines = [`GET ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const v = key.toLowerCase() === 'host' ? `127.0.0.1:${cfg.backendPort}` : value;
      if (Array.isArray(v)) for (const item of v) lines.push(`${key}: ${item}`);
      else lines.push(`${key}: ${v}`);
    }
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) target.write(head);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      target.destroy();
      socket.destroy();
    };
    target.on('close', close);
    target.on('error', close);
    socket.on('close', close);
    socket.on('error', close);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on('error', () => socket.destroy());
}

// ---------------------------------------------------------------------------
// 单请求兜底（只在 --upstream-timeout 0 时启用）
// ---------------------------------------------------------------------------

/**
 * 默认 10 分钟的静默超时已经够用；这里只解决「用户主动关掉上游超时」之后的无保护状态。
 * 计时从请求进入开始（含冷启动等待），任何数据往来都重置；超时只断开这一条请求，
 * 不遍历 S.sockets、不清零计数器 —— 计数由 res 的 close 事件自然递减。
 */
const REQUEST_WATCH = Symbol('requestWatch');

function requestWatchEnabled() {
  return cfg.requestTimeoutMs > 0 && cfg.upstreamTimeoutMs === 0;
}

function armRequestWatch(req, res) {
  if (!requestWatchEnabled()) return;
  const label = `${req.method} ${req.url}`;
  const rec = { timer: null, upstream: null, bump: null };
  const onTimeout = () => {
    rec.timer = null;
    if (res.destroyed || res.writableEnded) return;
    const ms = cfg.requestTimeoutMs;
    logger.info(
      `请求 ${label} 已 ${Math.round(ms / 1000)}s 没有数据往来，只断开这一条（--request-timeout）；` +
        'ComfyUI 里的任务不会被取消，仍会跑完',
    );
    try {
      rec.upstream?.destroy();
    } catch {
      /* 已经关了就算了 */
    }
    if (!res.headersSent) {
      sendJson(res, 504, {
        error: 'ComfyUI 后端响应超时',
        detail: `这一条请求 ${ms}ms 没有任何数据往来（可用 --request-timeout 调整）；后端任务本身不会被取消`,
      });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  };
  const schedule = () => {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(onTimeout, cfg.requestTimeoutMs);
    rec.timer.unref?.();
  };
  rec.bump = schedule;
  // 请求体也要算进展，但必须等 req.pipe(upstream) 接上之后再挂 'data'：
  // 提前挂会让 req 提前流动，冷启动那几秒里到达的 body 没有人接，直接丢掉。
  rec.attachBody = () => req.on('data', schedule);
  const cleanup = () => {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    req.off('data', schedule);
  };
  res.on('close', cleanup);
  res[REQUEST_WATCH] = rec;
  schedule();
}

async function handleRequest(req, res) {
  const pathname = String(req.url || '/').split('?')[0] || '/';
  const isStats = req.method === 'GET' && normalizePath(pathname) === '/system_stats';
  const passive = isPassive(req.method, pathname, cfg.passiveExtra);
  logger.debug(`${isStats ? 'STATS  ' : passive ? 'PASSIVE' : 'ACTIVE '} ${req.method} ${pathname}`);

  // 健康检查单独处理：running 时只转发，不刷新活跃时间。
  // 否则监控每 5 分钟轮询一次，后端永远不会进入空闲休眠。
  if (isStats) {
    if (S.state === 'running') {
      forward(req, res);
      return;
    }

    if (S.state === 'stopping') {
      // 正在结束后端时不能再 ensureBackend，否则会把刚停下的后端又拉起来。
      sendJson(res, 200, STATS_STUB, { 'x-lazy-state': 'stopping' });
      return;
    }

    if (S.state === 'stopped') {
      if (!passiveWakeAllowed({ state: S.state, lastWakeAt: S.lastPassiveWakeAt })) {
        sendJson(res, 200, STATS_STUB, {
          'x-lazy-state': 'cooldown',
          'x-lazy-note': 'passive probe ignored; backend stays asleep',
        });
        return;
      }
      S.lastPassiveWakeAt = Date.now();
      ensureBackend('健康检查').catch(() => {});
    }

    // starting，或刚由 stopped 触发启动：先回占位，后台继续启动。
    sendJson(res, 200, STATS_STUB, { 'x-lazy-state': S.state });
    return;
  }

  if (passive && S.state !== 'running') {
    sendJson(res, 503, { error: 'ComfyUI 正在休眠', state: S.state }, {
      'x-lazy-state': S.state,
      'retry-after': '30',
    });
    return;
  }

  if (!passive) {
    if (S.activeInFlight === 0) S.activeSince = Date.now();
    S.activeInFlight += 1;
    S.lastActivity = Date.now();
    if (S.hibernatedAt) S.hibernatedAt = 0;
    // 后端可能已被用户重启/升级；下一个空闲周期重新尝试 /free
    S.hibernationUnsupported = false;
    S.hibernateFailures = 0;
    res.on('close', () => {
      S.activeInFlight = Math.max(0, S.activeInFlight - 1);
      if (S.activeInFlight === 0) {
        S.activeSince = 0;
        // 也复位提示冷却，否则下一次挂死要等上一轮的 10 分钟窗口走完才会提示。
        S.stuckWarnAt = 0;
      }
      S.lastActivity = Date.now();
    });
    // 计时从请求进入开始，冷启动那段等待也要算进去。
    armRequestWatch(req, res);

    const ok = await withTimeout(ensureBackend('主动请求'), cfg.waitTimeoutMs);
    // 兜底超时可能已经把客户端断开了，别再往 ComfyUI 转发一条没人要的请求。
    if (res.destroyed || res.writableEnded) {
      req.resume();
      return;
    }
    if (!ok) {
      // 放弃这条请求时顺手把请求体读掉：否则上传中的大 body 没人消费，
      // 这条 keep-alive 连接会卡到对方超时（服务端 requestTimeout 是 0，不会自己断）。
      req.resume();
      sendJson(res, 503, {
        error: 'ComfyUI 后端不可用',
        detail: S.lastStartError || '后端仍在启动，或刚刚失败正在退避',
        state: S.state,
      }, {
        'x-lazy-state': S.state,
        'retry-after': '15',
      });
      return;
    }
  }

  forward(req, res);
}

// ---------------------------------------------------------------------------
// 启动 / 退出
// ---------------------------------------------------------------------------

function startServer() {
  upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.info(`请求处理异常: ${err?.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: '代理内部错误' });
      else res.destroy();
    });
  });

  server.requestTimeout = 0; // 生图请求可能很久，别让 Node 默认 5 分钟掐断
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  server.on('upgrade', handleUpgrade);
  server.on('connection', (socket) => {
    S.sockets.add(socket);
    socket.on('close', () => S.sockets.delete(socket));
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.info(`端口 ${cfg.listenPort} 已被占用：是不是已经有一个 lazy-comfy 在运行？`);
    } else {
      logger.info(`代理启动失败: ${err.message}`);
    }
    setTimeout(() => process.exit(1), 50);
  });
  server.listen(cfg.listenPort, '127.0.0.1', () => {
    logger.info(`代理已监听 http://127.0.0.1:${cfg.listenPort} -> 127.0.0.1:${cfg.backendPort}`);
  });
}

async function shutdown(signal) {
  if (S.shuttingDown) return;
  S.shuttingDown = true;
  logger?.info(`收到 ${signal}，准备退出`);

  if (S.timer) clearInterval(S.timer);
  try {
    server?.close();
  } catch {
    // ignore
  }
  server?.closeAllConnections?.();
  for (const socket of S.sockets) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }

  if (cfg?.stopOnExit) {
    const startingPid = S.state === 'starting' ? (S.startChild?.pid ?? S.pid ?? null) : null;
    if (startingPid) {
      const pid = startingPid;
      S.state = 'stopped';
      const ok = await stopProcessTree(pid);
      if (!ok && isAlive(pid)) {
        logger?.info(`退出时无法结束半启动的后端（pid ${pid}），它会留在后台，请手动清理`);
      }
    } else if (S.managed) {
      const stopped = await stopBackend('代理退出');
      if (!stopped && S.pid) {
        logger?.info(`退出时结束后端失败（pid ${S.pid} 仍在）；下次启动会按 PID 文件复用，或需手动结束`);
      }
    }
  } else if (S.state === 'starting' && S.pid) {
    // 没开 --stop-on-exit：半启动的后端照样会被留下，至少说一句，别静默留置。
    logger?.info(`后端还在启动（pid ${S.pid}）就退出了；它会继续启动并在下次运行时被接管，加 --stop-on-exit 可一起关闭`);
  } else if (S.managed && S.pid) {
    logger?.info(`后端继续运行（pid ${S.pid}）；下次启动会自动复用，加 --stop-on-exit 可一起关闭`);
  }

  upstreamAgent?.destroy();
  setTimeout(() => process.exit(0), 50);
}

async function main() {
  let parsed;
  try {
    parsed = parseConfig();
  } catch (err) {
    console.error(`lazy-comfy: ${err.message}\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  cfg = parsed;
  try {
    cfg.root = resolveRoot(cfg.root);
    cfg.python = resolvePython(cfg.root, cfg.python);
  } catch (err) {
    console.error(`lazy-comfy: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let stateDir;
  try {
    stateDir = resolveStateDir(cfg.stateDir);
  } catch (err) {
    console.error(`lazy-comfy: 无法创建状态目录: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  cfg.pidFile = path.join(stateDir, `comfy-${cfg.backendPort}.pid`);
  const logFile = cfg.logFile ? path.resolve(cfg.logFile) : path.join(stateDir, 'lazy.log');
  logger = createLogger({ file: logFile, debug: cfg.debug });
  if (!logger.fileOk) {
    console.error(`lazy-comfy: 无法写入日志 ${logFile}，仅输出到终端`);
  }

  S.lastActivity = Date.now();

  process.on('uncaughtException', (err) => {
    logger.info(`未捕获异常: ${err?.stack || err}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.info(`未处理的 rejection: ${err?.stack || err}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal).catch(() => process.exit(1));
    });
  }
  if (IS_WIN) {
    process.on('SIGBREAK', () => {
      shutdown('SIGBREAK').catch(() => process.exit(1));
    });
  }

  logger.info(`lazy-comfy ${VERSION}`);
  logger.info(`  代理:    http://127.0.0.1:${cfg.listenPort}`);
  logger.info(`  后端:    http://127.0.0.1:${cfg.backendPort}`);
  logger.info(`  ComfyUI: ${cfg.root}`);
  logger.info(`  Python:  ${cfg.python}`);
  logger.info(`  策略:    空闲 ${cfg.idleMin} 分钟卸载模型 / ${cfg.stopMin} 分钟结束后端`);
  logger.info(`  日志:    ${logFile}`);
  if (cfg.waitTimeoutMs < cfg.startTimeoutMs) {
    logger.info('提示: --wait-timeout 小于 --start-timeout，客户端会先收到 503，但后端仍会继续启动');
  }
  if (cfg.upstreamTimeoutMs === 0) {
    logger.info('提示: 已关闭上游静默超时（--upstream-timeout 0）；挂死请求可能让空闲策略停摆，建议保留默认值');
    if (cfg.requestTimeoutMs > 0) {
      logger.info(
        `提示: 单请求兜底已启用（--request-timeout ${cfg.requestTimeoutMs}ms）：` +
          '某条请求连续这么久没有数据往来时，只断开那一条，不影响其它请求',
      );
    } else {
      logger.info('提示: 单请求兜底也被关掉了（--request-timeout 0）；挂死的请求会一直占着空闲策略');
    }
  }
  const pkgVersion = readPackageVersion();
  if (pkgVersion && pkgVersion !== VERSION) {
    logger.info(`提示: 代码内版本 ${VERSION} 与 package.json 的 ${pkgVersion} 不一致，发版前请同步`);
  }

  // 上次进程留下的后端还在跑？复用，省掉一次冷启动。
  let running = false;
  const record = readPidFile();
  if (record && isAlive(record.pid)) {
    const looksRight = await looksLikeComfy(record.pid, cfg.root, cfg.backendPort);
    if (looksRight && await probe()) {
      markRunning(record.pid, { managed: true, how: 'adopt' });
      running = true;
    } else if (looksRight) {
      // 冷启动窗口里代理退出了：后端还在启动、只是还没响应。别把 PID 文件清掉，
      // 更不能把它降级成「外部后端」—— 那样之后 --stop 就再也杀不掉它。
      markRunning(record.pid, { managed: true, how: 'adopt-starting' });
      running = true;
    } else {
      logger.info(`无法确认 PID ${record.pid} 是本项目的 ComfyUI，按外部后端处理`);
      clearPidFile();
    }
  } else if (record) {
    clearPidFile();
  }

  if (!running && await probe()) {
    markRunning(null, { managed: false, how: 'external' });
  }

  startServer();
  S.timer = setInterval(() => {
    tick().catch((err) => logger.info(`看门狗异常: ${err?.stack || err}`));
  }, cfg.checkIntervalMs);
  S.timer.unref?.();
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`lazy-comfy: ${err?.stack || err}`);
    process.exit(1);
  });
}
