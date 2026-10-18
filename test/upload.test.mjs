import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { run } from '../lib/worker.mjs';
import { defaultSources } from '../lib/config.mjs';

const NOW = new Date('2026-10-18T12:00:00Z');

function call(overrides = {}) {
  return {
    t: '2026-10-16T10:05:00Z',
    agent: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    in: 100, out: 50, cache_read: 20, cache_write: 10, reasoning: 10,
    ms: 1200, status: 200,
    ...overrides,
  };
}

/** 起一个假 ingest 服务，记录收到的请求。 */
async function mockServer(t, handler) {
  const received = [];
  const server = createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(gunzipSync(raw).toString('utf8'));
      received.push({ url: req.url, auth: req.headers.authorization, body });
      const reply = handler ? handler(body) : { ingested: body.buckets.length };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, received };
}

async function setup(t, records, enable = ['claude']) {
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-upload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const magpieDir = join(dir, 'magpie');
  await mkdir(magpieDir, { recursive: true });
  const usageFile = join(magpieDir, 'usage.jsonl');
  await writeFile(usageFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const sources = defaultSources();
  for (const a of enable) sources[a].enabled = true;

  return {
    magpieDir, usageFile,
    othersDir: join(magpieDir, 'usage-others'),
    stateDir: join(magpieDir, 'vibecafe-import'),
    sources, includeOthers: false,
  };
}

test('没有开启任何 agent：不上传，返回 nothing-enabled', async (t) => {
  const mock = await mockServer(t);
  const config = await setup(t, [call()], []);
  config.apiUrl = mock.url;
  process.env.VIBECAFE_API_KEY = 'vbu_test';

  const result = await run(config, { now: NOW });
  assert.equal(result.status, 'nothing-enabled');
  assert.equal(mock.received.length, 0, '一条请求都不该发');
  delete process.env.VIBECAFE_API_KEY;
});

test('没有登录：不上传，返回 not-configured', async (t) => {
  const mock = await mockServer(t);
  const config = await setup(t, [call()]);
  config.apiUrl = mock.url;

  const result = await run(config, { now: NOW });
  assert.equal(result.status, 'not-configured');
  assert.equal(mock.received.length, 0);
});

test('正常上传：gzip + Bearer + 正确的桶', async (t) => {
  const mock = await mockServer(t);
  const config = await setup(t, [call()]);
  config.apiUrl = mock.url;
  process.env.VIBECAFE_API_KEY = 'vbu_test';

  const result = await run(config, { now: NOW });
  assert.equal(result.status, 'complete');
  assert.equal(result.submitted, 1);

  assert.equal(mock.received.length, 1);
  const req = mock.received[0];
  assert.equal(req.url, '/api/usage/ingest');
  assert.equal(req.auth, 'Bearer vbu_test');
  assert.equal(req.body.buckets.length, 1);
  assert.equal(req.body.buckets[0].source, 'claude-code');
  assert.equal(req.body.buckets[0].totalTokens, 160);

  delete process.env.VIBECAFE_API_KEY;
});

test('第二次运行：无变化则不再上传', async (t) => {
  const mock = await mockServer(t);
  const config = await setup(t, [call()]);
  config.apiUrl = mock.url;
  process.env.VIBECAFE_API_KEY = 'vbu_test';

  await run(config, { now: NOW });
  const second = await run(config, { now: NOW });

  assert.equal(second.status, 'unchanged');
  assert.equal(mock.received.length, 1, '只有第一次发了请求');

  delete process.env.VIBECAFE_API_KEY;
});

test('服务端丢弃未知 source：记账跳过，并给出明确警告', async (t) => {
  const mock = await mockServer(t, () => ({
    ingested: 0,
    dropped: { buckets: 1, unknownSources: ['claude-code'] },
  }));
  const config = await setup(t, [call()]);
  config.apiUrl = mock.url;
  process.env.VIBECAFE_API_KEY = 'vbu_test';

  const result = await run(config, { now: NOW });
  assert.equal(result.dropped.buckets, 1);
  assert.deepEqual(result.dropped.unknownSources, ['claude-code']);
  assert.ok(
    result.warnings.some((w) => w.includes('未注册的 source')),
    '必须明确告知用户数据没进去',
  );

  // 被丢弃的桶不记账，下次还会重试（等上游注册后能补上）
  const second = await run(config, { now: NOW });
  assert.equal(second.status, 'complete', '仍会重传被丢弃的桶');
  assert.equal(mock.received.length, 2);

  delete process.env.VIBECAFE_API_KEY;
});

test('401：返回 auth-blocked，不上报成功', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(401);
    res.end('{"error":"unauthorized"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const config = await setup(t, [call()]);
  config.apiUrl = `http://127.0.0.1:${port}`;
  process.env.VIBECAFE_API_KEY = 'vbu_bad';

  const result = await run(config, { now: NOW });
  assert.equal(result.status, 'auth-blocked');

  delete process.env.VIBECAFE_API_KEY;
});

test('服务端保留更大值：给出 protected 警告', async (t) => {
  const mock = await mockServer(t, () => ({
    ingested: 1,
    protected: { buckets: 1 },
  }));
  const config = await setup(t, [call()]);
  config.apiUrl = mock.url;
  process.env.VIBECAFE_API_KEY = 'vbu_test';

  const result = await run(config, { now: NOW });
  assert.equal(result.protected, 1);
  assert.ok(result.warnings.some((w) => w.includes('更大的已有桶')));

  delete process.env.VIBECAFE_API_KEY;
});

test('超过 100 个桶时分批上传', async (t) => {
  const mock = await mockServer(t);
  // 造 250 条不同半小时的记录
  const records = [];
  for (let i = 0; i < 250; i++) {
    const day = String(1 + Math.floor(i / 48)).padStart(2, '0');
    const half = i % 48;
    const hh = String(Math.floor(half / 2)).padStart(2, '0');
    const mm = half % 2 === 0 ? '00' : '30';
    records.push(call({ t: `2026-09-${day}T${hh}:${mm}:00Z` }));
  }
  const config = await setup(t, records);
  config.apiUrl = mock.url;
  process.env.VIBECAFE_API_KEY = 'vbu_test';

  const result = await run(config, { now: NOW });
  assert.equal(mock.received.length, 3, '250 个桶 → 3 批');
  assert.equal(result.submitted, 250);

  delete process.env.VIBECAFE_API_KEY;
});
