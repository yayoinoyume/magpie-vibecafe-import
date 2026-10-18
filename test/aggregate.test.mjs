import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aggregate, normalizeTokens, roundToHalfHour } from '../lib/aggregate.mjs';
import { defaultSources } from '../lib/config.mjs';

const NOW = new Date('2026-03-10T12:00:00Z');

/** 一条 magpie usage.jsonl 记录，字段与 internal/usage/usage.go 的 Record 对齐。 */
function call(overrides = {}) {
  return {
    t: '2026-03-08T12:00:00Z',
    agent: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    in: 100,
    out: 50,
    cache_read: 20,
    cache_write: 10,
    reasoning: 10,
    ms: 1200,
    status: 200,
    ...overrides,
  };
}

async function setup(t, records, { enable = ['claude'], others } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const magpieDir = join(dir, 'magpie');
  await mkdir(magpieDir, { recursive: true });
  const usageFile = join(magpieDir, 'usage.jsonl');
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  await writeFile(usageFile, lines.join('\n') + (lines.length ? '\n' : ''));

  if (others) {
    const othersDir = join(magpieDir, 'usage-others');
    for (const [computer, payload] of Object.entries(others)) {
      await mkdir(join(othersDir, computer), { recursive: true });
      await writeFile(join(othersDir, computer, payload.day + '.json'), JSON.stringify(payload));
    }
  }

  const sources = defaultSources();
  for (const agent of enable) sources[agent].enabled = true;

  return {
    magpieDir,
    usageFile,
    othersDir: join(magpieDir, 'usage-others'),
    stateDir: join(magpieDir, 'vibecafe-import'),
    apiUrl: 'https://vibecafe.ai',
    sources,
    includeOthers: false,
    startDate: undefined,
  };
}

// ---- token 分桶 ----

test('out 含 reasoning：outputTokens 必须减掉 reasoning，不重复计数', () => {
  const tokens = normalizeTokens(call({ in: 100, out: 50, reasoning: 10, cache_read: 20, cache_write: 10 }));
  assert.equal(tokens.inputTokens, 100);
  assert.equal(tokens.outputTokens, 40, 'out 50 减去 reasoning 10');
  assert.equal(tokens.reasoningOutputTokens, 10);
  assert.equal(tokens.cachedInputTokens, 20);
  assert.equal(tokens.cacheCreation5mTokens, 10);
  assert.equal(tokens.cacheCreation1hTokens, 0);
});

test('cache_write_1h 从 cache_write 里拆出，不重复计数', () => {
  const tokens = normalizeTokens(call({ cache_write: 10, cache_write_1h: 4 }));
  assert.equal(tokens.cacheCreation1hTokens, 4, '1h 部分');
  assert.equal(tokens.cacheCreation5mTokens, 6, '剩余 5m 部分');
});

test('reasoning 大于 out 视为坏记录', () => {
  assert.throws(() => normalizeTokens(call({ out: 5, reasoning: 10 })), /reasoning 大于 out/);
});

test('cache_write_1h 大于 cache_write 视为坏记录', () => {
  assert.throws(
    () => normalizeTokens(call({ cache_write: 3, cache_write_1h: 5 })),
    /cache_write_1h 大于 cache_write/,
  );
});

test('半小时取整：00:29 → 00:00，00:30 → 00:30', () => {
  assert.equal(roundToHalfHour(new Date('2026-03-08T12:29:59Z')), '2026-03-08T12:00:00.000Z');
  assert.equal(roundToHalfHour(new Date('2026-03-08T12:30:00Z')), '2026-03-08T12:30:00.000Z');
});

// ---- 开关行为 ----

test('默认全部关闭时，一条都不导入，且不读文件', async (t) => {
  const config = await setup(t, [call()], { enable: [] });
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0);
  assert.equal(snapshot.diagnostics.records, 0, '没有开启任何 agent 时直接返回，不读 usage.jsonl');
});

test('开启后正常导入，source 映射正确', async (t) => {
  const config = await setup(t, [call()], { enable: ['claude'] });
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
  const bucket = snapshot.buckets[0];
  assert.equal(bucket.source, 'claude-code');
  assert.equal(bucket.model, 'claude-sonnet-5');
  assert.equal(bucket.project, 'unknown', 'magpie 不记录项目路径');
  assert.equal(bucket.bucketStart, '2026-03-08T12:00:00.000Z');
  // totalTokens 不含 cachedInputTokens —— 缓存读取单独计价，计入会重复。
  // 与 vibe-usage 的 aggregateToBuckets() 保持一致。
  assert.equal(bucket.totalTokens, 100 + 40 + 10 + 10);
  assert.equal(bucket.cachedInputTokens, 20, '缓存读取单独记录，不进 totalTokens');
});

test('未开启的 agent 计入 notEnabled，不进桶', async (t) => {
  const config = await setup(t, [call({ agent: 'codex' })], { enable: ['claude'] });
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0);
  assert.equal(snapshot.diagnostics.notEnabled, 1);
});

test('无 source 映射的 agent 计入 unknownAgent', async (t) => {
  const config = await setup(t, [call({ agent: 'zed' })], { enable: ['zed'] });
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0);
  // zed 有映射但 source 为 null，enabledAgents 会排除它
  assert.equal(snapshot.diagnostics.records, 0, 'config 没开任何有效 agent 时直接返回');
});

test('开了但无 source 的 agent 会被识别为 ineffective', async (t) => {
  const config = await setup(t, [call({ agent: 'zed' })], { enable: ['zed'] });
  const snapshot = await aggregate(config, { now: NOW });
  assert.deepEqual(snapshot.ineffective, ['zed']);
});

// ---- 时间边界 ----

test('今天及以后的记录不上传', async (t) => {
  const config = await setup(t, [
    call({ t: '2026-03-10T00:00:01Z' }),
    call({ t: '2026-03-08T12:00:00Z' }),
  ]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.diagnostics.future, 1);
});

test('startDate 之前的记录被排除', async (t) => {
  const config = await setup(t, [
    call({ t: '2026-03-01T12:00:00Z' }),
    call({ t: '2026-03-08T12:00:00Z' }),
  ]);
  config.startDate = '2026-03-05';
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.diagnostics.beforeStart, 1);
});

// ---- 过滤 ----

test('rejected 的记录不上传', async (t) => {
  const config = await setup(t, [call({ rejected: true })]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0);
});

test('没有 provider 的 4xx 记录不上传', async (t) => {
  const config = await setup(t, [call({ provider: '', status: 429 })]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0);
});

test('全零 token 的记录不上传', async (t) => {
  const config = await setup(t, [call({ in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0 })]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0);
});

test('坏 JSON 行被跳过，不影响其他行', async (t) => {
  const config = await setup(t, ['not-json', call()]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.diagnostics.malformed, 1);
});

test('usage.jsonl 不存在时安静返回，不抛错', async (t) => {
  // 真实场景：用户开了 agent，但 magpie 还没产生第一次调用。
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const magpieDir = join(dir, 'magpie');
  await mkdir(magpieDir, { recursive: true });
  // 故意不创建 usage.jsonl

  const sources = defaultSources();
  sources.claude.enabled = true;
  const config = {
    magpieDir,
    usageFile: join(magpieDir, 'usage.jsonl'),
    othersDir: join(magpieDir, 'usage-others'),
    stateDir: join(magpieDir, 'vibecafe-import'),
    apiUrl: 'https://vibecafe.ai',
    sources, includeOthers: false,
  };

  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 0, '没有文件就是没有数据，不是错误');
  assert.equal(snapshot.diagnostics.records, 0);
});

test('不完整的末行（正在写入）被忽略', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const magpieDir = join(dir, 'magpie');
  await mkdir(magpieDir, { recursive: true });
  const usageFile = join(magpieDir, 'usage.jsonl');
  // 第一行完整，第二行没有换行结尾
  await writeFile(usageFile, JSON.stringify(call()) + '\n' + JSON.stringify(call({ in: 999 })));

  const sources = defaultSources();
  sources.claude.enabled = true;
  const config = {
    magpieDir, usageFile,
    othersDir: join(magpieDir, 'usage-others'),
    stateDir: join(magpieDir, 'vibecafe-import'),
    apiUrl: 'https://vibecafe.ai',
    sources, includeOthers: false,
  };

  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.buckets[0].inputTokens, 100, '只算完整那一行');
});

// ---- 聚合 ----

test('同一半小时、同模型的多次调用合并成一个桶', async (t) => {
  const config = await setup(t, [
    call({ t: '2026-03-08T12:01:00Z' }),
    call({ t: '2026-03-08T12:29:00Z' }),
  ]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.buckets[0].inputTokens, 200);
});

test('跨半小时边界的调用分成两个桶', async (t) => {
  const config = await setup(t, [
    call({ t: '2026-03-08T12:29:00Z' }),
    call({ t: '2026-03-08T12:31:00Z' }),
  ]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 2);
});

test('served 优先于 model 作为模型名', async (t) => {
  const config = await setup(t, [call({ model: 'claude-sonnet-5', served: 'claude-sonnet-5-20260801' })]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets[0].model, 'claude-sonnet-5-20260801');
});

// ---- 跨机 ----

test('includeOthers 关闭时不读 usage-others', async (t) => {
  const config = await setup(t, [call()], {
    others: { abc12345: { computer: 'abc12345', name: 'laptop', day: '2026-03-08', calls: [call()] } },
  });
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1, '只有本机那一条');
});

test('includeOthers 开启时读 usage-others，hostname 用机器名', async (t) => {
  const config = await setup(t, [call()], {
    others: {
      abc12345: { computer: 'abc12345', name: 'yayoi-laptop', day: '2026-03-08', calls: [call()] },
    },
  });
  config.includeOthers = true;
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 2, '本机 + 另一台机器');

  const others = snapshot.buckets.filter((b) => b.hostname === 'yayoi-laptop');
  assert.equal(others.length, 1);
  assert.equal(others[0].source, 'claude-code');
});

test('跨机文件损坏时只跳过那一个，不影响本机', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const magpieDir = join(dir, 'magpie');
  await mkdir(magpieDir, { recursive: true });
  await writeFile(join(magpieDir, 'usage.jsonl'), JSON.stringify(call()) + '\n');
  const brokenDir = join(magpieDir, 'usage-others', 'deadbeef');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(join(brokenDir, '2026-03-08.json'), '{ broken');

  const sources = defaultSources();
  sources.claude.enabled = true;
  const config = {
    magpieDir,
    usageFile: join(magpieDir, 'usage.jsonl'),
    othersDir: join(magpieDir, 'usage-others'),
    stateDir: join(magpieDir, 'vibecafe-import'),
    apiUrl: 'https://vibecafe.ai',
    sources,
    includeOthers: true,
  };

  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1, '本机数据仍在');
  assert.equal(snapshot.diagnostics.brokenFiles, 1);
});

test('WSL agent id 归一化后能匹配', async (t) => {
  const config = await setup(t, [call({ agent: 'claude@wsl:Ubuntu' })]);
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1);
});

// ---- hostname 策略 ----

test('默认用系统主机名', async (t) => {
  const config = await setup(t, [call()]);
  const snapshot = await aggregate(config, { now: NOW });
  const { hostname } = await import('node:os');
  assert.equal(snapshot.buckets[0].hostname, hostname().replace(/\.local$/, ''));
});

test('配置了 hostname 时，本机数据用该值', async (t) => {
  const config = await setup(t, [call()]);
  config.hostname = 'central-magpie';
  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets[0].hostname, 'central-magpie');
});

test('配置了 hostname 时，跨机数据也归到该值', async (t) => {
  const config = await setup(t, [call()], {
    others: {
      abc12345: { computer: 'abc12345', name: 'yayoi-laptop', day: '2026-03-08', calls: [call()] },
    },
  });
  config.includeOthers = true;
  config.hostname = 'central-magpie';

  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 1, '两台机器合并成同一个 key');
  assert.equal(snapshot.buckets[0].hostname, 'central-magpie');
  assert.equal(snapshot.buckets[0].inputTokens, 200, 'token 累加');
});

test('未配置 hostname 时，跨机数据保留各自机器名', async (t) => {
  const config = await setup(t, [call()], {
    others: {
      abc12345: { computer: 'abc12345', name: 'yayoi-laptop', day: '2026-03-08', calls: [call()] },
    },
  });
  config.includeOthers = true;

  const snapshot = await aggregate(config, { now: NOW });
  assert.equal(snapshot.buckets.length, 2, '两台机器分开');
  assert.deepEqual(snapshot.otherComputers, ['yayoi-laptop']);
});
