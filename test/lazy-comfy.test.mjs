import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigError,
  VERSION,
  isPassive,
  normalizePath,
  parseConfig,
  passiveWakeAllowed,
  stopBackoffMs,
} from '../lazy-comfy.mjs';

test('默认配置', () => {
  const cfg = parseConfig([], {});
  assert.equal(cfg.listenPort, 8189);
  assert.equal(cfg.backendPort, 8188);
  assert.equal(cfg.idleMin, 10);
  assert.equal(cfg.stopMin, 30);
  assert.equal(cfg.startTimeoutMs, 180_000);
  assert.equal(cfg.waitTimeoutMs, 190_000);
  assert.equal(cfg.upstreamTimeoutMs, 600_000);
  assert.equal(cfg.requestTimeoutMs, 7_200_000);
  assert.equal(cfg.checkIntervalMs, 30_000);
  assert.equal(cfg.hibernateRetry, 3);
  assert.equal(cfg.probeFailLimit, 0);
  assert.equal(cfg.stopOnExit, false);
  assert.equal(cfg.debug, false);
  assert.deepEqual(cfg.passiveExtra, []);
});

test('环境变量生效', () => {
  const cfg = parseConfig([], {
    LAZY_PORT: '9100',
    COMFY_PORT: '9200',
    COMFY_ROOT: '/tmp/ComfyUI',
    COMFY_PYTHON: '/tmp/python',
    LAZY_IDLE_MIN: '1.5',
    LAZY_STOP_MIN: '0',
    LAZY_DEBUG: '1',
    LAZY_STOP_ON_EXIT: 'true',
    LAZY_PASSIVE_EXTRA: '^/metrics$,^/health$',
    LAZY_HIBERNATE_RETRY: '5',
    LAZY_PROBE_FAIL_LIMIT: '4',
  });
  assert.equal(cfg.listenPort, 9100);
  assert.equal(cfg.backendPort, 9200);
  assert.equal(cfg.root, '/tmp/ComfyUI');
  assert.equal(cfg.python, '/tmp/python');
  assert.equal(cfg.idleMin, 1.5);
  assert.equal(cfg.stopMin, 0);
  assert.equal(cfg.debug, true);
  assert.equal(cfg.stopOnExit, true);
  assert.equal(cfg.hibernateRetry, 5);
  assert.equal(cfg.probeFailLimit, 4);
  assert.equal(cfg.passiveExtra.length, 2);
});

test('命令行覆盖环境变量', () => {
  const cfg = parseConfig(
    ['--port', '9300', '--backend', '9400', '--idle', '3', '--stop', '8',
      '--hibernate-retry', '4', '--probe-fail-limit', '5', '--debug'],
    { LAZY_PORT: '9100', COMFY_PORT: '9200', LAZY_IDLE_MIN: '5' },
  );
  assert.equal(cfg.listenPort, 9300);
  assert.equal(cfg.backendPort, 9400);
  assert.equal(cfg.idleMin, 3);
  assert.equal(cfg.stopMin, 8);
  assert.equal(cfg.hibernateRetry, 4);
  assert.equal(cfg.probeFailLimit, 5);
  assert.equal(cfg.debug, true);
});

test('可重复的 --passive-extra', () => {
  const cfg = parseConfig(['--passive-extra', '^/metrics$', '--passive-extra', '^/health$'], {});
  assert.equal(cfg.passiveExtra.length, 2);
  assert.equal(isPassive('GET', '/metrics', cfg.passiveExtra), true);
  assert.equal(isPassive('GET', '/api/health', cfg.passiveExtra), true);
  assert.equal(isPassive('GET', '/other', cfg.passiveExtra), false);
});

test('非法端口 / 相同端口 / 未知参数', () => {
  assert.throws(() => parseConfig(['--port', '0'], {}), ConfigError);
  assert.throws(() => parseConfig(['--port', '70000'], {}), ConfigError);
  assert.throws(() => parseConfig(['--port', 'abc'], {}), ConfigError);
  assert.throws(() => parseConfig(['--port', '8188', '--backend', '8188'], {}), /不能和/);
  assert.throws(() => parseConfig(['--wat'], {}), ConfigError);
  assert.throws(() => parseConfig(['--passive-extra', '['], {}), /正则无效/);
  assert.throws(() => parseConfig(['--hibernate-retry', '0'], {}), ConfigError);
  assert.throws(() => parseConfig(['--hibernate-retry', '21'], {}), ConfigError);
  assert.throws(() => parseConfig(['--probe-fail-limit', '-1'], {}), ConfigError);
  assert.throws(() => parseConfig(['--probe-fail-limit', '21'], {}), ConfigError);
});

test('--upstream-timeout 解析与环境变量', () => {
  assert.equal(parseConfig(['--upstream-timeout', '0'], {}).upstreamTimeoutMs, 0);
  assert.equal(parseConfig(['--upstream-timeout', '90000'], {}).upstreamTimeoutMs, 90_000);
  assert.equal(parseConfig([], { LAZY_UPSTREAM_TIMEOUT_MS: '120000' }).upstreamTimeoutMs, 120_000);
  assert.throws(() => parseConfig(['--upstream-timeout', '-1'], {}), ConfigError);
});

test('--request-timeout 解析与环境变量', () => {
  assert.equal(parseConfig([], {}).requestTimeoutMs, 7_200_000);
  assert.equal(parseConfig(['--request-timeout', '0'], {}).requestTimeoutMs, 0);
  assert.equal(parseConfig(['--request-timeout', '1200'], {}).requestTimeoutMs, 1_200);
  assert.equal(parseConfig([], { LAZY_REQUEST_TIMEOUT_MS: '90000' }).requestTimeoutMs, 90_000);
  assert.throws(() => parseConfig(['--request-timeout', '-1'], {}), ConfigError);
});

test('--help / --version 直接返回', () => {
  assert.deepEqual(parseConfig(['--help'], {}), { help: true });
  assert.deepEqual(parseConfig(['-v'], {}), { version: true });
  assert.equal(VERSION, '1.1.8');
});

test('normalizePath 去掉 /api 前缀', () => {
  assert.equal(normalizePath('/api/prompt'), '/prompt');
  assert.equal(normalizePath('/api'), '/');
  assert.equal(normalizePath('/prompt'), '/prompt');
  assert.equal(normalizePath('/apiary'), '/apiary');
});

test('被动请求分类', () => {
  // 只读探测：不唤醒
  assert.equal(isPassive('GET', '/prompt'), true);
  assert.equal(isPassive('GET', '/queue'), true);
  assert.equal(isPassive('GET', '/history'), true);
  assert.equal(isPassive('GET', '/history/abc-123'), true);
  assert.equal(isPassive('GET', '/models'), true);
  assert.equal(isPassive('GET', '/embeddings'), true);
  assert.equal(isPassive('GET', '/api/queue'), true);
  assert.equal(isPassive('GET', '/api/prompt?x=1'), true);
  assert.equal(isPassive('get', '/queue'), true);

  // 主动请求：记活跃 + 唤醒
  assert.equal(isPassive('POST', '/prompt'), false);
  assert.equal(isPassive('POST', '/interrupt'), false);
  assert.equal(isPassive('GET', '/view'), false);
  assert.equal(isPassive('GET', '/'), false);
  assert.equal(isPassive('GET', '/system_stats'), false);
  assert.equal(isPassive('GET', '/object_info'), false);

  // 边界
  assert.equal(isPassive('GET', '/models/checkpoints'), false);
  assert.equal(isPassive('GET', '/prompt/123'), false);
  assert.equal(isPassive('GET', '/queue?x=1'), true);

  // 用户追加
  const extra = [/^\/metrics$/];
  assert.equal(isPassive('GET', '/metrics', extra), true);
  assert.equal(isPassive('GET', '/api/metrics', extra), true);
});

// --- 1.1.2 新增：退避 / 挂死释放 / 被动唤醒限频 ---

test('--upstream-timeout 0 表示关闭静默超时', () => {
  const cfg = parseConfig(['--upstream-timeout', '0'], {});
  assert.equal(cfg.upstreamTimeoutMs, 0);
  assert.throws(() => parseConfig(['--upstream-timeout', '-1'], {}), ConfigError);
});

test('stopBackoffMs：30s 起翻倍并封顶 5 分钟', () => {
  assert.equal(stopBackoffMs(1), 30_000);
  assert.equal(stopBackoffMs(2), 60_000);
  assert.equal(stopBackoffMs(3), 120_000);
  assert.equal(stopBackoffMs(4), 240_000);
  assert.equal(stopBackoffMs(5), 300_000);
  assert.equal(stopBackoffMs(50), 300_000);
  assert.equal(stopBackoffMs(0), 30_000);
});

test('passiveWakeAllowed：10 分钟内不重复拉起', () => {
  const now = 1_000_000_000;
  assert.equal(passiveWakeAllowed({ state: 'stopped', lastWakeAt: 0, now }), true);
  assert.equal(passiveWakeAllowed({ state: 'stopped', lastWakeAt: now - 60_000, now }), false);
  assert.equal(passiveWakeAllowed({ state: 'stopped', lastWakeAt: now - 10 * 60_000, now }), true);
  // 启动中/运行中不受限，避免把正常启动当成冷却
  assert.equal(passiveWakeAllowed({ state: 'starting', lastWakeAt: now, now }), true);
  assert.equal(passiveWakeAllowed({ state: 'running', lastWakeAt: now, now }), true);
});
