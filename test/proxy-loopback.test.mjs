// 端到端回归：不需要 POSIX shell，Windows 上也会真跑（test/proxy.test.mjs 会 skip）。
// 覆盖：慢上游 -> 504、--upstream-timeout 0 的静默退让、被动路由不唤醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'lazy-comfy.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeout = 15_000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}

function canConnect(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Windows 上 child.kill() 走 TerminateProcess，代理来不及（也不会）做 SIGTERM 清理，
// 所以测试收尾要按 PID 文件补刀，否则每跑一次就留一个假后端。
function killPidFile(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record?.pid) return;
    try {
      process.kill(-record.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        // 已经没了
      }
    }
  } catch {
    // 没有 pid 文件
  }
}

// 假 ComfyUI：/system_stats 立刻回；其它请求按 delayMs 延迟，或永不回复。
async function startFake({ delayMs = 0, hang = false, stream = false, busy = false, queueMode = null } = {}) {
  const mode = queueMode ?? (busy ? 'running' : 'idle');
  const hits = [];
  let freeCalls = 0;
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    if (req.url === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"system":{"comfyui_version":"fake"},"devices":[]}');
      return;
    }
    if (req.url === '/queue') {
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'running') {
        res.end('{"queue_running":[{"prompt_id":"busy-1"}],"queue_pending":[]}');
      } else if (mode === 'pending') {
        // 批量任务：还没开始跑，只有 pending
        res.end('{"queue_running":[],"queue_pending":[{"prompt_id":"p1"},{"prompt_id":"p2"}]}');
      } else {
        res.end('{"queue_running":[],"queue_pending":[]}');
      }
      return;
    }
    if (req.url === '/free' && req.method === 'POST') {
      freeCalls++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (stream && req.url === '/stream') {
      hits.push(req.url);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return; }
        res.write('x'.repeat(64));
        n++;
        if (n >= 30) { clearInterval(timer); res.end(); }
      }, 100);
      req.on('close', () => clearInterval(timer));
      return;
    }
    hits.push(req.url);
    req.resume();
    if (hang) return;
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, delayMs);
  });
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    hits,
    get freeCalls() { return freeCalls; },
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        srv.close(() => r());
      }),
  };
}

async function startProxy({ backendPort, extra = [], idle = '0', stop = '0', env = {}, backendSource = null, pidRecord = null, prepareRoot = null }) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-proxy-'));
  // --root 校验要求有 main.py；测试里不需要真的能启动
  fs.writeFileSync(path.join(dir, 'main.py'), '# fake ComfyUI entry\n');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  // prepareRoot 拿到的是代理真正的 --root：Linux 下 looksLikeComfy() 会比进程 cwd 和它，
  // 所以僵尸后端必须在这个目录里启动，否则会被当成外部后端。
  if (prepareRoot) {
    const prepared = await prepareRoot(dir);
    if (prepared?.pidRecord) {
      fs.writeFileSync(
        path.join(stateDir, `comfy-${backendPort}.pid`),
        JSON.stringify(prepared.pidRecord),
      );
    }
  } else if (pidRecord) {
    // 模拟「上次代理在冷启动里退出了，留下一条 starting 记录」
    fs.writeFileSync(path.join(stateDir, `comfy-${backendPort}.pid`), JSON.stringify(pidRecord));
  }
  // --python 也要求文件存在；这个假解释器只用于通过校验，不会被真的用于启动
  let python = path.join(dir, 'python.exe');
  fs.writeFileSync(python, '');
  let childEnv = { ...env };
  if (backendSource) {
    // 让代理真的 spawn 一个后端：拿 node 当 python，入口换成 main.cjs。
    fs.writeFileSync(path.join(dir, 'main.cjs'), backendSource);
    python = process.execPath;
    childEnv = { ...childEnv, LAZY_ENTRY: 'main.cjs' };
  }
  const logFile = path.join(dir, 'proxy.log');
  const child = spawn(
    process.execPath,
    [
      CLI,
      '--port', String(port),
      '--backend', String(backendPort),
      '--root', dir,
      '--python', python,
      '--state-dir', path.join(dir, 'state'),
      '--log', logFile,
      '--idle', idle,
      '--stop', stop,
      '--check-interval', '300',
      // 测试结束时把假后端一起带走，避免每次跑测试在机器上留 node main.cjs。
      '--stop-on-exit',
      ...extra,
    ],
    { stdio: 'ignore', env: { ...process.env, ...childEnv } },
  );
  const up = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/system_stats`);
      return r.status === 200;
    } catch {
      return false;
    }
  });
  assert.equal(up, true, '代理没有起来');
  return {
    port,
    dir,
    log: () => fs.readFileSync(logFile, 'utf8'),
    // 关代理时要等它真的退出：不等就删临时目录会 EBUSY，
    // 而且测试进程可能比它自己的后端活得久，留下 node main.py 的残留。
    stop: () => new Promise((resolve) => {
      const pidFile = path.join(stateDir, `comfy-${backendPort}.pid`);
      // Windows 上 child.kill() 是 TerminateProcess，代理来不及跑 --stop-on-exit 的清理，
      // 所以关掉代理后要按 PID 文件补刀（外部后端的 pid 文件不存在，killPidFile 会静默跳过）。
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        killPidFile(pidFile);
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      const timer = setTimeout(finish, 5_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
      child.kill();
    }),
  };
}

test('慢上游会拿到 504，且不误判为后端故障', async (t) => {
  const fake = await startFake({ delayMs: 5_000 });
  const proxy = await startProxy({ backendPort: fake.port, extra: ['--upstream-timeout', '1200'] });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"prompt":{}}',
  });
  const body = await res.json();
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 504);
  assert.match(body.error, /超时/);
  assert.ok(elapsed < 4_000, `504 来得太慢: ${elapsed}ms`);
  assert.equal(fake.hits.length, 1, '上游应该收到一次请求');
  assert.match(proxy.log(), /（1s 没有数据往来）|没有数据往来/);
});

test('--upstream-timeout 0：完全关闭静默超时，启动时提示风险', async (t) => {
  const fake = await startFake({ hang: true });
  const proxy = await startProxy({ backendPort: fake.port, extra: ['--upstream-timeout', '0'] });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  assert.match(proxy.log(), /已关闭上游静默超时/);
  assert.match(proxy.log(), /可能让空闲策略停摆/);

  await assert.rejects(
    fetch(`http://127.0.0.1:${proxy.port}/view?filename=x.png`, { signal: AbortSignal.timeout(2_500) }),
    '挂起的请求不应被静默超时提前掐断',
  );
});

test('持续有数据的慢请求不会被强制释放', async (t) => {
  const fake = await startFake({ stream: true });
  const proxy = await startProxy({
    backendPort: fake.port,
    extra: ['--upstream-timeout', '1200', '--check-interval', '200'],
  });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/stream`);
  const body = await res.text();
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 200);
  assert.equal(body.length, 30 * 64, '慢流被提前截断');
  assert.ok(elapsed >= 2500, `请求完成得太快，可能被强制释放: ${elapsed}ms`);
});

test('/system_stats 轮询不会阻止空闲休眠', async (t) => {
  const fake = await startFake();
  const proxy = await startProxy({
    backendPort: fake.port,
    idle: '0.05',
    stop: '0.2',
    extra: ['--check-interval', '200'],
  });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  for (let i = 0; i < 5; i++) {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/system_stats`);
    assert.equal(r.status, 200);
    await sleep(1000);
  }

  const hibernated = await waitFor(() => proxy.log().includes('已卸载模型'), 4_000);
  assert.equal(hibernated, true, `stats 轮询阻止了休眠\n${proxy.log()}`);
  assert.ok(fake.freeCalls >= 1, '没有调用 /free');
});

test('后端睡着时，被动路由直接 503 且不唤醒', async (t) => {
  const deadPort = await freePort(); // 没有任何后端在这里监听
  const proxy = await startProxy({ backendPort: deadPort });
  t.after(() => proxy.stop());

  const res = await fetch(`http://127.0.0.1:${proxy.port}/queue`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /休眠/);

  const stats = await fetch(`http://127.0.0.1:${proxy.port}/system_stats`);
  assert.equal(stats.status, 200);
  assert.match(stats.headers.get('x-lazy-state') || '', /stopped|starting|cooldown/);
});

test('--request-timeout 1200：挂死请求只断开这一条', async (t) => {
  const fake = await startFake({ hang: true });
  const proxy = await startProxy({
    backendPort: fake.port,
    extra: ['--upstream-timeout', '0', '--request-timeout', '1200'],
  });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  assert.match(proxy.log(), /单请求兜底已启用/);

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/view?filename=x.png`);
  const body = await res.json();
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 504);
  assert.match(body.error, /超时/);
  assert.ok(elapsed < 4_000, `504 来得太慢: ${elapsed}ms`);
  assert.match(proxy.log(), /只断开这一条/);
  assert.match(proxy.log(), /request-timeout/);

  // 代理本身没被这条请求拖死
  const stats = await fetch(`http://127.0.0.1:${proxy.port}/system_stats`);
  assert.equal(stats.status, 200);
});

test('--request-timeout 下，持续有数据的请求不会被兜底掐断', async (t) => {
  const fake = await startFake({ stream: true });
  const proxy = await startProxy({
    backendPort: fake.port,
    extra: ['--upstream-timeout', '0', '--request-timeout', '1200'],
  });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxy.port}/stream`);
  const body = await res.text();
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 200);
  assert.equal(body.length, 30 * 64, '慢流被兜底超时截断');
  assert.ok(elapsed >= 2500, `请求完成得太快: ${elapsed}ms`);
  assert.doesNotMatch(proxy.log(), /只断开这一条/);
});

// --request-timeout 的实现要监听 req 的 'data'（请求体也算进展），
// 但监听必须等 req.pipe(upstream) 接上之后 —— 提前挂会让 req 提前流动，
// 冷启动那几秒里到达的 body 没人接，直接丢掉。
test('冷启动期间到达的请求体不会丢（--request-timeout 开着）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-body-'));
  const backendPort = await freePort();
  const proxyPort = await freePort();
  // 入口写成 main.cjs（LAZY_ENTRY 指过去）：晚 900ms 才开始监听，收到 POST 就回显字节数。
  // 不用 main.py + node —— Node 23+ 对未知扩展名直接报 ERR_UNKNOWN_FILE_EXTENSION。
  const mainSource = `const http = require('node:http');
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const port = Number(i >= 0 ? argv[i + 1] : 8188);
setTimeout(() => {
  http
    .createServer((req, res) => {
      if (req.url === '/system_stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"system":{"comfyui_version":"slow"},"devices":[]}');
        return;
      }
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: n }));
      });
    })
    .listen(port, '127.0.0.1');
}, 900);
`;
  fs.writeFileSync(path.join(dir, 'main.py'), '# placeholder; entry is main.cjs\n');
  fs.writeFileSync(path.join(dir, 'main.cjs'), mainSource);
  const logFile = path.join(dir, 'proxy.log');
  const child = spawn(
    process.execPath,
    [
      CLI,
      '--port', String(proxyPort),
      '--backend', String(backendPort),
      '--root', dir,
      '--python', process.execPath,
      '--state-dir', path.join(dir, 'state'),
      '--log', logFile,
      '--idle', '0',
      '--stop', '0',
      '--check-interval', '300',
      // 测试结束时把假后端一起带走，避免每次跑测试在机器上留 node main.cjs。
      '--stop-on-exit',
      '--upstream-timeout', '0',
      '--request-timeout', '5000',
    ],
    { stdio: 'ignore', env: { ...process.env, LAZY_ENTRY: 'main.cjs' } },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    // Windows 上 child.kill() 是 TerminateProcess，代理自己的 SIGTERM 清理根本不会跑，
    // --stop-on-exit 也就带不走后端；这里按 PID 文件补一刀，否则每次都留一个假后端。
    killPidFile(path.join(dir, 'state', `comfy-${backendPort}.pid`));
    await waitFor(async () => !(await canConnect(backendPort, 200)), 5_000);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const up = await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${proxyPort}/system_stats`)).status === 200;
    } catch {
      return false;
    }
  });
  assert.equal(up, true, '代理没有起来');

  const payload = 'x'.repeat(200 * 1024);
  const res = await fetch(`http://127.0.0.1:${proxyPort}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: payload,
  });
  const body = await res.json();
  assert.equal(res.status, 200, `冷启动转发失败: ${res.status}`);
  assert.equal(body.received, payload.length, '冷启动期间到达的请求体被丢掉了');
});

// 出图期间的流量只有 ws 进度和被动轮询，都不刷新 lastActivity。
// 如果看门狗只看空闲时间，就会把正在出图的后端卸掉/杀掉 —— 必须问 /queue。
for (const [mode, label] of [['running', '正在跑'], ['pending', '排队中']]) {
  test(`后端队列里还有任务（${label}）时，不卸载模型、也不结束后端`, async (t) => {
    const fake = await startFake({ queueMode: mode });
    const proxy = await startProxy({ backendPort: fake.port, idle: '0.05', stop: '0.1' });
    t.after(async () => {
      await proxy.stop();
      killPidFile(path.join(proxy.dir, 'state', `comfy-${fake.port}.pid`));
      await fake.close();
      fs.rmSync(proxy.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const noticed = await waitFor(() => /队列里还有任务在跑/.test(proxy.log()), 15_000, 200);
    assert.equal(noticed, true, `看门狗没有识别到「队列非空」(${mode}): ${proxy.log().split('\n').slice(-6).join(' | ')}`);

    // 再多等几个检查周期：这段时间里空闲阈值早就过了，仍然不能动
    await sleep(1_200);
    assert.equal(fake.freeCalls, 0, `队列里有任务时不该 /free 卸模型（${mode}）`);
    assert.equal(await canConnect(fake.port, 500), true, `队列里有任务时不该结束后端进程（${mode}）`);
  });
}

// /queue 自己失败时（超时、5xx）不能当成「没活干」，否则检查失败反而变成「确认可以杀」。
test('GET /queue 失败时保守跳过本轮，不卸载也不结束', async (t) => {
  const fake = await startFake({ queueMode: 'error' });
  const proxy = await startProxy({ backendPort: fake.port, idle: '0.05', stop: '0.1' });
  t.after(async () => {
    await proxy.stop();
    killPidFile(path.join(proxy.dir, 'state', `comfy-${fake.port}.pid`));
    await fake.close();
    fs.rmSync(proxy.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const noticed = await waitFor(() => /\/queue 检查失败/.test(proxy.log()), 15_000, 200);
  assert.equal(noticed, true, `/queue 失败时没有保守跳过: ${proxy.log().split('\n').slice(-6).join(' | ')}`);
  await sleep(1_200);
  assert.equal(fake.freeCalls, 0, '/queue 检查失败时不该 /free');
  assert.equal(await canConnect(fake.port, 500), true, '/queue 检查失败时不该结束后端');
});

// 冷启动要 40–60 秒，这期间代理被杀掉，后端还在启动。
// 新代理必须认回这个后端（否则会当外部后端，之后 --stop 永远杀不掉它）。
test('冷启动中代理退出后，重启能接管启动中的后端并继续按空闲策略结束它', async (t) => {
  const backendPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-adopt-'));
  const mainCjs = path.join(dir, 'main.cjs');
  // 假 ComfyUI 后端：**永远不监听**，模拟「启动到一半、还没开始响应」。
  // 不能用「晚 1.2 秒再监听」的写法：Windows 上 looksLikeComfy 要起 powershell 查命令行，
  // CI 的 2 核 runner 冷启动就是 1~4 秒，等查完后端早就监听好了，
  // 代理会走进「已在运行 → 复用」的另一条分支，这条用例就会假红。
  fs.writeFileSync(mainCjs, `
// 永不监听；只能被 taskkill 结束
setInterval(() => {}, 1000);
`, 'utf8');
  fs.writeFileSync(path.join(dir, 'main.py'), '# placeholder; entry is main.cjs\n');

  const backend = spawn(process.execPath, [mainCjs, '--listen', '127.0.0.1', '--port', String(backendPort)], { stdio: 'ignore', cwd: dir });
  t.after(async () => {
    try { process.kill(backend.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
    await waitFor(() => !canConnect(backendPort, 200), 5_000);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // 模拟「上次代理启动到一半就被杀」：PID 文件已经落盘（state=starting），后端还没监听
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `comfy-${backendPort}.pid`),
    JSON.stringify({ pid: backend.pid, port: backendPort, root: dir, state: 'starting' }),
    'utf8',
  );

  const logFile = path.join(dir, 'proxy.log');
  const proxyPort = await freePort();
  const child = spawn(process.execPath, [
    CLI,
    '--port', String(proxyPort),
    '--backend', String(backendPort),
    '--root', dir,
    '--python', process.execPath,
    '--state-dir', stateDir,
    '--log', logFile,
    '--idle', '30',
    '--stop', '0.05',
    '--check-interval', '200',
    '--stop-on-exit',
  ], { stdio: 'ignore', env: { ...process.env, LAZY_ENTRY: 'main.cjs' } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  });

  const adopted = await waitFor(() => {
    try { return /接管上次没启动完的后端/.test(fs.readFileSync(logFile, 'utf8')); } catch { return false; }
  }, 15_000, 200);
  assert.equal(adopted, true, '新代理没有接管启动中的后端，会把它当外部后端');

  // 接管后必须仍然「归我管」：--stop 到点要把这个后端结束掉（看进程真的没了，不看端口）
  const exited = await new Promise((resolve) => {
    if (backend.exitCode !== null || backend.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 20_000);
    backend.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.equal(exited, true, '接管后的后端没有按 --stop 结束，说明托管权丢了');
});

// 回归：1.1.7 的 /queue 守卫曾经把「未知」一律当成「先跳过」，结果后端一死，
// /queue 永远失败 -> 每轮都 return -> 看门狗再也发现不了它没了。
// 这里同时验两件事：活着但 /queue 报错时保守跳过；后端真的没了时仍能被发现。
test('后端死后 /queue 也失败时，看门狗仍然要能发现它没了', async (t) => {
  const fake = await startFake({ queueMode: 'error' });
  const proxy = await startProxy({ backendPort: fake.port, idle: '0.05', stop: '0.5' });
  t.after(async () => {
    await proxy.stop();
    await fake.close();
  });

  // 活着但 /queue 500：保守跳过，不能卸模型
  await sleep(4_000);
  assert.match(proxy.log(), /\/queue 检查失败/, '/queue 报错时应当记一条保守跳过的日志');
  assert.doesNotMatch(proxy.log(), /已卸载模型/, '/queue 报错时不该卸载模型');

  const before = await fetch(`http://127.0.0.1:${proxy.port}/queue`);
  assert.equal(before.status, 500, '活着时 /queue 应当被如实转发（假后端返回 500）');

  // 后端真的死了：必须从「运行中」掉回「已停止」，否则空闲策略永久停摆
  await fake.close();
  const noticed = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/queue`).catch(() => null);
    return r?.status === 503;
  }, 12_000, 250);
  assert.equal(noticed, true, '后端已经死了，代理却一直停在「跳过本轮」，看门狗失效');
});

// 造一个「代理自己 spawn 的」假后端：queue 可配置忙/闲，可以延迟监听。
function backendServer({ queue = 'idle', listenDelay = 0 } = {}) {
  return `
const http = require('http');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const body = {
  idle: '{"queue_running":[],"queue_pending":[]}',
  busy: '{"queue_running":[{"prompt_id":"gen"}],"queue_pending":[]}',
}[${JSON.stringify(queue)}];
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"system":{"comfyui_version":"fake"}}');
      return;
    }
    if (req.url === '/queue') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  }).listen(port, '127.0.0.1');
}, ${listenDelay});
`;
}

test('托管后端队列忙时，--stop 到点也不许杀（不是外部后端那种「本来就不杀」）', async (t) => {
  const backendPort = await freePort();
  const proxy = await startProxy({
    backendPort,
    idle: '0.02',
    stop: '0.05',
    backendSource: backendServer({ queue: 'busy' }),
  });
  t.after(() => proxy.stop());

  const started = await waitFor(() => /后端已就绪/.test(proxy.log()), 15_000, 200);
  assert.equal(started, true, '代理没有把自己的后端拉起来');

  await sleep(6_000);
  assert.match(proxy.log(), /队列里还有任务在跑/);
  assert.equal(await canConnect(backendPort, 500), true, '队列忙时后端被杀了');
  assert.doesNotMatch(proxy.log(), /结束后端进程/);
});

test('spawn 成功就落 PID 文件，状态是 starting（不是等就绪才写）', async (t) => {
  const backendPort = await freePort();
  const proxy = await startProxy({
    backendPort,
    idle: '0',
    stop: '0',
    backendSource: backendServer({ queue: 'idle', listenDelay: 4_000 }),
  });
  t.after(() => proxy.stop());

  const pidFile = path.join(proxy.dir, 'state', `comfy-${backendPort}.pid`);
  const written = await waitFor(() => fs.existsSync(pidFile), 10_000, 100);
  assert.equal(written, true, 'spawn 之后没有立刻写 PID 文件，冷启动被打断就会丢托管');

  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(record.state, 'starting', `PID 文件状态应当是 starting，实际 ${record.state}`);
  assert.equal(await canConnect(backendPort, 300), false, '这个假后端还没开始监听，测试前提不成立');
});

test('接管来的启动中后端永远不 ready 时，按启动超时结束掉，不留孤儿', async (t) => {
  const backendPort = await freePort();
  let zombie = null;
  t.after(() => {
    try { zombie?.kill('SIGKILL'); } catch { /* 已经没了 */ }
  });

  // 僵尸进程必须在代理的 --root 里启动：Linux 下 looksLikeComfy() 比的是
  // 进程真实 cwd 和 cfg.root（不是 PID 文件里的 root），不匹配就会被当外部后端。
  const proxy = await startProxy({
    backendPort,
    idle: '0',
    stop: '0',
    env: { LAZY_ENTRY: 'main.cjs' },
    extra: ['--start-timeout', '1500'],
    prepareRoot: (dir) => {
      const entry = path.join(dir, 'main.cjs');
      fs.writeFileSync(entry, 'setTimeout(() => {}, 60000);\n');
      zombie = spawn(
        process.execPath,
        [entry, '--listen', '127.0.0.1', '--port', String(backendPort), '--disable-auto-launch'],
        { cwd: dir, stdio: 'ignore' },
      );
      return { pidRecord: { pid: zombie.pid, port: backendPort, root: dir, state: 'starting' } };
    },
  });
  t.after(() => proxy.stop());

  const taken = await waitFor(() => /接管上次没启动完的后端/.test(proxy.log()), 10_000, 200);
  assert.equal(taken, true, '代理没有接管这个 starting 记录');

  const timedOut = await waitFor(() => /启动超时/.test(proxy.log()), 12_000, 200);
  assert.equal(timedOut, true, '接管的启动中后端没有启动超时，会永远卡在 starting');

  const gone = await waitFor(() => {
    try { process.kill(zombie.pid, 0); return false; } catch { return true; }
  }, 10_000, 200);
  assert.equal(gone, true, '超时后没有结束那个半启动的进程，留下孤儿');
});
