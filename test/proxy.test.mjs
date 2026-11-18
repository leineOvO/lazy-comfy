import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lazy-comfy.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
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

function request(port, method, pathname, body, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': payload.length }
        : {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('error', (err) => finish({ status: 0, error: err.code || err.message, headers: {}, body: null }));
    req.on('timeout', () => {
      req.destroy();
      finish({ status: 0, error: 'timeout', headers: {}, body: null });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 10_000, intervalMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function waitExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

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
        // already gone
      }
    }
  } catch {
    // no pid file
  }
}

test('按需启动 -> 卸载模型 -> 结束后端 -> 再次唤醒', { timeout: 60_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-comfy-test-'));
  const root = path.join(tmp, 'ComfyUI');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(root, { recursive: true });

  const backendPort = await freePort();
  let proxyPort = await freePort();
  while (proxyPort === backendPort) proxyPort = await freePort();

  // 代理执行 `<python> <entry> --listen … --port N`。这里把 python 指向 node 本身、
  // 把入口写成 main.cjs（通过 LAZY_ENTRY 指定），于是任何平台都不需要 shell 垫片，
  // 也不依赖 Node 对 .py 这种未知扩展名的处理方式（Node 23+ 会直接报错）。
  const mainSource = `const http = require('node:http');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const port = Number(index >= 0 ? argv[index + 1] : 8188);
let freeCalls = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/system_stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ system: { comfyui_version: 'fake' }, devices: [] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/free') {
    freeCalls += 1;
    req.resume();
    if (freeCalls === 1) {
      // 模拟一次临时失败：代理应重试，而不是立刻杀掉后端
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('transient free failure');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.method === 'POST' && req.url === '/prompt') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'fake-prompt', bytes: Buffer.concat(chunks).length }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/queue') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"queue_pending":[]}');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('fake backend');
});
server.listen(port, '127.0.0.1');
`;

  // --root 校验要求目录里有 main.py；真正的入口是 main.cjs（LAZY_ENTRY 指过去）
  fs.writeFileSync(path.join(root, 'main.py'), '# placeholder; entry is main.cjs\n');
  fs.writeFileSync(path.join(root, 'main.cjs'), mainSource);

  const fakePython = process.execPath;

  const logFile = path.join(stateDir, 'lazy.log');
  const proxies = [];
  const proxy = spawn(process.execPath, [
    SCRIPT,
    '--port', String(proxyPort),
    '--backend', String(backendPort),
    '--root', root,
    '--python', fakePython,
    '--state-dir', stateDir,
    '--log', logFile,
    '--idle', '0.05', // 3s
    '--stop', '0.1',  // 6s
    '--check-interval', '200',
    '--debug',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAZY_ENTRY: 'main.cjs' } });
  proxies.push(proxy);

  let output = '';
  proxy.stdout.on('data', (chunk) => { output += chunk; });
  proxy.stderr.on('data', (chunk) => { output += chunk; });

  const pidFile = path.join(stateDir, `comfy-${backendPort}.pid`);
  const details = () => `\n--- proxy output ---\n${output}\n--- log ---\n${readLog(logFile)}`;

  t.after(async () => {
    for (const child of proxies) {
      child.kill('SIGTERM');
      await waitExit(child);
    }
    killPidFile(pidFile);
    // 假后端的 cwd 就是 ComfyUI 目录：Windows 上进程没退干净时 rmdir 会 EBUSY，
    // 于是这里等到端口关闭再删，并且给几次重试。
    await waitFor(async () => !(await canConnect(backendPort, 200)), 5_000);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        await sleep(150);
      }
    }
    throw new Error(`临时目录删不掉（可能是假后端还没退出）: ${tmp}`);
  });

  assert.equal(await waitFor(() => canConnect(proxyPort), 8_000), true, `代理未监听${details()}`);

  // 1) 后端没起时，被动探测直接 503，不应该触发生成进程
  const asleep = await request(proxyPort, 'GET', '/queue');
  assert.equal(asleep.status, 503, `被动探测应返回 503${details()}`);
  assert.equal(asleep.headers['x-lazy-state'], 'stopped');
  assert.equal(await canConnect(backendPort), false, '被动探测不应该唤醒后端');

  // 2) 主动请求触发冷启动并等待后端就绪
  const prompt = await request(proxyPort, 'POST', '/prompt', { prompt: {} });
  assert.equal(prompt.status, 200, `POST /prompt 应该成功${details()}`);
  assert.equal(prompt.body.prompt_id, 'fake-prompt');

  const queue = await request(proxyPort, 'GET', '/queue');
  assert.equal(queue.status, 200);
  assert.equal(queue.body.queue_pending.length, 0);

  // 3) 空闲 3s 后卸载模型，但进程还在
  const hibernated = await waitFor(() => readLog(logFile).includes('已卸载模型'), 8_000);
  assert.equal(hibernated, true, `没有进入休眠${details()}`);
  assert.match(readLog(logFile), /卸载模型失败（HTTP 500），第 1\/3 次/,
    `临时失败没有重试，而是直接降级${details()}`);
  const statsAfterHibernate = await request(backendPort, 'GET', '/system_stats');
  assert.equal(statsAfterHibernate.status, 200, '休眠不应该结束进程');

  // 4) 空闲 6s 后真正结束后端
  const stopped = await waitFor(() => readLog(logFile).includes('后端已结束'), 8_000);
  assert.equal(stopped, true, `没有结束后端${details()}`);
  assert.equal(await waitFor(async () => !(await request(backendPort, 'GET', '/system_stats')).status, 3_000), true);

  // 5) 停止后被动探测回到 503
  const asleepAgain = await request(proxyPort, 'GET', '/api/queue');
  assert.equal(asleepAgain.status, 503);
  assert.equal(asleepAgain.headers['x-lazy-state'], 'stopped');

  // 6) 健康检查拿到占位 stats，同时后台拉起后端
  const stub = await request(proxyPort, 'GET', '/system_stats');
  assert.equal(stub.status, 200);
  assert.equal(stub.body.system.comfyui_version, 'starting');

  const woke = await waitFor(async () => (await request(proxyPort, 'POST', '/prompt', {})).status === 200, 10_000);
  assert.equal(woke, true, `健康检查后没有成功唤醒${details()}`);

  // 7) 代理退出时默认保留后端；下次启动读取 PID 文件复用，避免再次冷启动
  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(typeof record.pid, 'number');
  proxy.kill('SIGTERM');
  await waitExit(proxy);
  assert.equal((await request(backendPort, 'GET', '/system_stats')).status, 200, '默认退出不应结束后端');

  const logFile2 = path.join(stateDir, 'lazy-2.log');
  const proxy2 = spawn(process.execPath, [
    SCRIPT,
    '--port', String(proxyPort),
    '--backend', String(backendPort),
    '--root', root,
    '--python', fakePython,
    '--state-dir', stateDir,
    '--log', logFile2,
    '--idle', '10',
    '--stop', '30',
    // 第二个代理是「复用已有后端」的场景：让它退出时把后端一起带走，
    // 否则每跑一次测试都会在机器上留一个 node main.cjs 的假后端。
    '--stop-on-exit',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAZY_ENTRY: 'main.cjs' } });
  proxies.push(proxy2);
  assert.equal(await waitFor(() => canConnect(proxyPort), 8_000), true, `第二个代理未监听${readLog(logFile2)}`);
  const adopted = await waitFor(() => readLog(logFile2).includes('复用上次启动的后端'), 5_000);
  assert.equal(adopted, true, `没有复用已有后端\n${readLog(logFile2)}`);
  assert.equal((await request(proxyPort, 'GET', '/queue')).status, 200);
});
