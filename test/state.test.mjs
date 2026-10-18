import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bucketHash, bucketKey } from '../lib/aggregate.mjs';
import {
  diffBuckets, loadState, pruneState, recordUploaded, saveState, stateIdentity,
} from '../lib/state.mjs';

function bucket(overrides = {}) {
  return {
    source: 'claude-code',
    model: 'claude-sonnet-5',
    project: 'unknown',
    hostname: 'dev',
    bucketStart: '2026-03-08T12:00:00.000Z',
    inputTokens: 100,
    outputTokens: 40,
    cachedInputTokens: 20,
    reasoningOutputTokens: 10,
    cacheCreation5mTokens: 10,
    cacheCreation1hTokens: 0,
    totalTokens: 160,
    ...overrides,
  };
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-state-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { stateDir: dir, apiUrl: 'https://vibecafe.ai' };
}

test('首次运行：所有桶都是新增', async (t) => {
  const config = await setup(t);
  const state = await loadState(config, stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_test' }));
  const diff = diffBuckets([bucket()], state, bucketKey, bucketHash);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.unchanged.length, 0);
});

test('已上传且未变化：跳过', async (t) => {
  const config = await setup(t);
  const identity = stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_test' });
  const state = await loadState(config, identity);
  const b = bucket();
  recordUploaded(state, bucketKey(b), bucketHash(b), b.totalTokens);

  const diff = diffBuckets([b], state, bucketKey, bucketHash);
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.unchanged.length, 1);
});

test('值变大：重新上传（服务端 upsert 覆盖）', async (t) => {
  const config = await setup(t);
  const identity = stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_test' });
  const state = await loadState(config, identity);
  const before = bucket({ inputTokens: 100, totalTokens: 160 });
  recordUploaded(state, bucketKey(before), bucketHash(before), before.totalTokens);

  // 同一桶又累积了调用
  const after = bucket({ inputTokens: 200, totalTokens: 260 });
  const diff = diffBuckets([after], state, bucketKey, bucketHash);
  assert.equal(diff.changed.length, 1, '值变大必须重传');
});

test('值变小：不上传，记为 regressed', async (t) => {
  const config = await setup(t);
  const identity = stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_test' });
  const state = await loadState(config, identity);
  const big = bucket({ inputTokens: 200, totalTokens: 260 });
  recordUploaded(state, bucketKey(big), bucketHash(big), big.totalTokens);

  // 本地日志被截断，值变小
  const small = bucket({ inputTokens: 50, totalTokens: 110 });
  const diff = diffBuckets([small], state, bucketKey, bucketHash);
  assert.equal(diff.changed.length, 0, '变小不上传');
  assert.equal(diff.regressed.length, 1, '但要记账，避免每次重试');
});

test('状态原子写入并可读回', async (t) => {
  const config = await setup(t);
  const identity = stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_test' });
  const state = await loadState(config, identity);
  const b = bucket();
  recordUploaded(state, bucketKey(b), bucketHash(b), b.totalTokens);
  await saveState(config, state, identity);

  const reloaded = await loadState(config, identity);
  assert.deepEqual(reloaded.buckets, state.buckets);

  // 权限：0600（POSIX）
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(join(config.stateDir, 'state.json'))).mode & 0o777;
    assert.equal(mode, 0o600, 'state.json 必须只有本人可读写');
  }
});

test('换账号：状态清空并标记 identityChanged', async (t) => {
  const config = await setup(t);
  const first = stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_first' });
  const state = await loadState(config, first);
  const b = bucket();
  recordUploaded(state, bucketKey(b), bucketHash(b), b.totalTokens);
  await saveState(config, state, first);

  // 换了一个 key
  const second = stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_second' });
  const reloaded = await loadState(config, second);
  assert.equal(reloaded.identityChanged, true);
  assert.deepEqual(reloaded.buckets, {}, '新账号不能继承旧账号的检查点');
});

test('状态文件损坏：当作空，触发重传', async (t) => {
  const config = await setup(t);
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(join(config.stateDir, 'state.json'), '{ broken');

  const state = await loadState(config, stateIdentity({ apiUrl: config.apiUrl, token: 'vbu_test' }));
  assert.deepEqual(state.buckets, {});
  assert.equal(state.corrupt, true);
});

test('pruneState 只清理本次解析成功的 source', async (t) => {
  const state = { buckets: {} };
  const a = bucket({ source: 'claude-code', bucketStart: '2026-03-08T12:00:00.000Z' });
  const b = bucket({ source: 'codex', bucketStart: '2026-03-08T12:00:00.000Z' });
  recordUploaded(state, bucketKey(a), bucketHash(a), a.totalTokens);
  recordUploaded(state, bucketKey(b), bucketHash(b), b.totalTokens);

  // 本次只解析了 claude-code，且它没有产出现有 key（比如日志被删）
  pruneState(state, new Set(), new Set(['claude-code']));
  const keys = Object.keys(state.buckets);
  assert.equal(keys.length, 1, 'codex 的 key 必须保留');
  assert.ok(keys[0].startsWith('codex|'));
});
