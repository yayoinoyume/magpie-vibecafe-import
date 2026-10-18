#!/usr/bin/env node
// 对真实 vibecafe 服务端的联调自检。
//
// 安全设计（每一条都是为了不污染真实用量）：
//   1. 用固定前缀 + 随机后缀的 hostname，且断言它不在账号现有数据里
//   2. 只上传 1 个桶、2 个 token，模型名用真实存在的（否则服务端会静默丢弃）
//   3. 无论成功失败，finally 里都按 hostname 精确删除
//   4. 结束时再查一次，确认沙箱数据为 0
//
// 用法：
//   VIBECAFE_API_KEY=vbu_xxx node scripts/selftest.mjs
//   VIBECAFE_API_KEY=vbu_xxx node scripts/selftest.mjs --keep   # 保留数据供人工查看

import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const API = process.env.VIBECAFE_API_URL || 'https://vibecafe.ai';
const KEY = process.env.VIBECAFE_API_KEY;
const KEEP = process.argv.includes('--keep');
const HOST = `vibecafe-selftest-${randomBytes(3).toString('hex')}`;

// 用真实模型名。实测：价格表里没有的模型会被服务端静默丢弃。
const TEST_MODEL = process.env.SELFTEST_MODEL || 'claude-sonnet-5';

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => console.log(`  ✗ ${msg}`);

function headers() {
  return { authorization: `Bearer ${KEY}` };
}

async function getUsage(days = 30) {
  const res = await fetch(`${API}/api/usage?days=${days}&bucketsOnly=true`, {
    headers: headers(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET /api/usage 返回 ${res.status}`);
  return res.json();
}

async function ingest(buckets) {
  const body = gzipSync(Buffer.from(JSON.stringify({ buckets })));
  const res = await fetch(`${API}/api/usage/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      ...headers(),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  return { status: res.status, body: text, json: safeJSON(text) };
}

async function removeHost(host) {
  const res = await fetch(`${API}/api/usage/ingest?hostname=${encodeURIComponent(host)}`, {
    method: 'DELETE',
    headers: headers(),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  return { status: res.status, json: safeJSON(text) };
}

function safeJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  if (!KEY) {
    console.error('缺少 VIBECAFE_API_KEY 环境变量。');
    process.exit(1);
  }

  let exitCode = 0;
  let wrote = false;

  try {
    log(`\n[1/5] 验证密钥与账号`);
    const before = await getUsage();
    const account = before?.account?.handle;
    if (!account) throw new Error('响应里没有 account 字段，密钥可能无效');
    ok(`账号 ${account}`);
    ok(`现有数据 ${before.buckets?.length ?? 0} 个桶`);

    const existingHosts = new Set((before.buckets ?? []).map((b) => b.hostname));
    if (existingHosts.has(HOST)) {
      throw new Error(`沙箱 hostname ${HOST} 已存在于账号数据中，拒绝继续（避免误删真实数据）`);
    }
    ok(`沙箱 hostname ${HOST} 与现有数据不冲突`);

    log(`\n[2/5] 上传 1 个测试桶`);
    const bucket = {
      source: 'claude-code',
      model: TEST_MODEL,
      project: 'unknown',
      hostname: HOST,
      bucketStart: new Date(Date.now() - 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z',
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      totalTokens: 2,
    };
    const up = await ingest([bucket]);
    wrote = true;
    if (up.status !== 200) throw new Error(`ingest 返回 ${up.status}: ${up.body.slice(0, 200)}`);
    ok(`HTTP 200 · ${up.body.slice(0, 120)}`);

    log(`\n[3/5] 确认数据落库`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await getUsage();
    const mine = (after.buckets ?? []).filter((b) => b.hostname === HOST);
    if (mine.length === 0) {
      bad('数据未落库 —— 可能是模型名不在价格表里（这会静默丢弃）');
      exitCode = 1;
    } else {
      ok(`找到 ${mine.length} 个桶`);
      const b = mine[0];
      const fields = [
        'source', 'model', 'project', 'hostname', 'bucketStart',
        'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens',
        'cacheCreation5mTokens', 'cacheCreation1hTokens', 'totalTokens',
      ];
      const missing = fields.filter((f) => !(f in b));
      if (missing.length) {
        bad(`缺少字段：${missing.join(', ')}`);
        exitCode = 1;
      } else {
        ok('12 个字段全部返回，结构兼容');
      }
      ok(`estimatedCost 由服务端计算：${b.estimatedCost}`);
    }

    log(`\n[4/5] 清理沙箱数据`);
    if (KEEP) {
      log(`  --keep 指定，保留 ${HOST} 的数据，请手动删除：`);
      log(`  curl -X DELETE -H "Authorization: Bearer $VIBECAFE_API_KEY" "${API}/api/usage/ingest?hostname=${HOST}"`);
    } else {
      const del = await removeHost(HOST);
      if (del.status !== 200) {
        bad(`删除失败 HTTP ${del.status}`);
        exitCode = 1;
      } else {
        ok(`已删除 ${del.json?.deleted ?? '?'} 个桶`);
        wrote = false;
      }
    }

    log(`\n[5/5] 验证清理结果`);
    if (!KEEP) {
      await new Promise((r) => setTimeout(r, 1000));
      const final = await getUsage();
      const leftover = (final.buckets ?? []).filter((b) => b.hostname === HOST);
      if (leftover.length === 0) {
        ok('沙箱数据已清空');
      } else {
        bad(`仍有 ${leftover.length} 个残留`);
        exitCode = 1;
      }
      const real = (final.buckets ?? []).filter((b) => b.hostname !== HOST);
      ok(`真实数据 ${real.length} 个桶，hostname：${[...new Set(real.map((b) => b.hostname))].join(', ')}`);
    }
  } catch (error) {
    bad(error.message);
    exitCode = 1;
    // 出错也要尽力清理
    if (wrote) {
      log(`\n尝试清理 ${HOST} ...`);
      try {
        const del = await removeHost(HOST);
        log(`  ${del.status === 200 ? '已删除' : '删除失败'}：${JSON.stringify(del.json)}`);
      } catch (e) {
        log(`  清理也失败了：${e.message}`);
        log(`  请手动删除：curl -X DELETE -H "Authorization: Bearer $VIBECAFE_API_KEY" "${API}/api/usage/ingest?hostname=${HOST}"`);
      }
    }
  }

  log(exitCode === 0 ? '\n自检通过。' : '\n自检失败。');
  process.exit(exitCode);
}

main();
