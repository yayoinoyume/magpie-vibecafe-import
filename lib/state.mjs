import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// 增量上传状态。
//
// 与 vibe-usage 的 state.json 是两回事 —— 那是 CLI 自己的文件，格式随版本变。
// 这里只记录本插件已成功上传过哪些桶，用于「跳过没变的桶」。
//
// 关键语义（与 vibe-usage 服务端一致）：
//   服务端按 (user, source, model, project, hostname, bucket_start) upsert。
//   同一个 key 再次上传更大的值会覆盖；上传更小的值会被服务端保留旧值
//   （客户端输出里叫 protected）。所以：
//   - 值没变 → 不必传
//   - 值变大 → 必须传
//   - 值变小 → 传了也没用，但要记账，避免每次重复尝试
//
// 仓库根目录放 state.json，权限 0600。

export const STATE_VERSION = 1;

export function stateIdentity({ apiUrl, token }) {
  return {
    apiUrl: apiUrl || '',
    keyFingerprint: token
      ? createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
      : '',
  };
}

function sameIdentity(a, b) {
  return a.apiUrl === b.apiUrl && a.keyFingerprint === b.keyFingerprint;
}

function isIdentity(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.apiUrl === 'string'
    && typeof value.keyFingerprint === 'string';
}

export function statePath(config) {
  return join(config.stateDir, 'state.json');
}

/**
 * 读状态。identity 不匹配时返回空状态 + identityChanged 标记 —— 换了账号
 * 就必须重传，否则新账号永远收不到历史。
 */
export async function loadState(config, identity) {
  let raw;
  try {
    raw = JSON.parse(await readFile(statePath(config), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { buckets: {}, identityChanged: false };
    // 状态损坏 → 当作空，触发一次全量重传，绝不丢数据。
    return { buckets: {}, identityChanged: false, corrupt: true };
  }

  const buckets = raw?.buckets ?? {};
  if (!isIdentity(identity) || !isIdentity(raw?.identity)) {
    return { buckets, identityChanged: false };
  }
  if (sameIdentity(raw.identity, identity)) {
    return { buckets, identityChanged: false };
  }
  return { buckets: {}, identityChanged: true };
}

/** 原子写入：临时文件 + fsync + rename。 */
export async function saveState(config, state, identity) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  try {
    await chmod(config.stateDir, 0o700);
  } catch {
    // Windows 上权限模型不同，忽略。
  }

  const payload = { version: STATE_VERSION, buckets: state.buckets ?? {} };
  if (isIdentity(identity)) payload.identity = identity;

  const target = statePath(config);
  const temp = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify(payload, null, 2) + '\n');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temp, target);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * 选出需要上传的桶。
 *
 * 返回 { changed, unchanged, regressed }：
 *   changed   —— 新桶或值变大，需要上传
 *   unchanged —— 值没变，跳过
 *   regressed —— 值变小（本地日志被截断过），上传无效，只记账
 */
export function diffBuckets(buckets, state, bucketKeyFn, bucketHashFn) {
  const changed = [];
  const unchanged = [];
  const regressed = [];

  for (const bucket of buckets) {
    const key = bucketKeyFn(bucket);
    const hash = bucketHashFn(bucket);
    const seen = state.buckets[key];
    if (seen === undefined) {
      changed.push({ bucket, key, hash });
    } else if (seen.hash === hash) {
      unchanged.push({ bucket, key, hash });
    } else if ((bucket.totalTokens || 0) >= (seen.tokens || 0)) {
      changed.push({ bucket, key, hash });
    } else {
      regressed.push({ bucket, key, hash });
    }
  }
  return { changed, unchanged, regressed };
}

/** 记录一次成功上传。tokens 用于下次判断增减。 */
export function recordUploaded(state, key, hash, tokens) {
  state.buckets[key] = { hash, tokens };
}

/**
 * 清理已不存在的桶。
 *
 * 只在该桶所属 source 本次解析完整时才清 —— 否则一次读失败会把状态清空，
 * 下次全量重传。调用方传入 okSources。
 */
export function pruneState(state, liveKeys, okSources) {
  for (const key of Object.keys(state.buckets)) {
    const source = key.slice(0, key.indexOf('|'));
    if (okSources && !okSources.has(source)) continue;
    if (!liveKeys.has(key)) delete state.buckets[key];
  }
}
