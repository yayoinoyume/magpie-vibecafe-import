import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

import { enabledAgents, ineffectiveAgents } from './config.mjs';
import { lookupAgent } from './sources.mjs';

// vibe-usage 的桶是半小时粒度。服务端按
// (user, source, model, project, hostname, bucket_start) 去重。
const HALF_HOUR_MS = 30 * 60 * 1000;
const MODEL_MAX_LENGTH = 100;
const PROJECT_MAX_LENGTH = 200;
const MAX_LINE_BYTES = 1024 * 1024;

const safeInteger = (v) => Number.isSafeInteger(v) && v >= 0;

// 向下取整到半小时，与 vibe-usage 的 roundToHalfHour() 一致（UTC 基准）。
export function roundToHalfHour(date) {
  const ms = date.getTime();
  return new Date(Math.floor(ms / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

/**
 * 规范化一条 magpie 记录为 vibe-usage 的 token 分桶。
 *
 * 字段对应关系（magpie → vibe-usage）：
 *   in                → inputTokens
 *   out - reasoning   → outputTokens
 *   reasoning         → reasoningOutputTokens
 *   cache_read        → cachedInputTokens
 *   cache_write - cache_write_1h → cacheCreation5mTokens
 *   cache_write_1h    → cacheCreation1hTokens
 *
 * 注意 magpie 的 out 已经包含 reasoning，必须减掉，否则重复计数。
 * 这一点在 magpie 源码 internal/usage/usage.go 的 Record 注释和
 * vibe-usage AGENTS.md 的 Pi 解析器说明里都写明了。
 */
export function normalizeTokens(record) {
  const input = record.in ?? 0;
  const rawOutput = record.out ?? 0;
  const reasoning = record.reasoning ?? 0;
  const cacheRead = record.cache_read ?? 0;
  const cacheWrite = record.cache_write ?? 0;
  const oneHour = record.cache_write_1h ?? 0;

  for (const [name, value] of Object.entries({ input, rawOutput, reasoning, cacheRead, cacheWrite, oneHour })) {
    if (!safeInteger(value)) throw new Error(`Invalid token count in ${name}.`);
  }
  if (reasoning > rawOutput) throw new Error('reasoning 大于 out，记录不一致。');
  if (oneHour > cacheWrite) throw new Error('cache_write_1h 大于 cache_write，记录不一致。');

  return {
    inputTokens: input,
    outputTokens: rawOutput - reasoning,
    reasoningOutputTokens: reasoning,
    cachedInputTokens: cacheRead,
    cacheCreation5mTokens: cacheWrite - oneHour,
    cacheCreation1hTokens: oneHour,
  };
}

function tokenSum(tokens) {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.reasoningOutputTokens +
    tokens.cacheCreation5mTokens +
    tokens.cacheCreation1hTokens
  );
}

/**
 * 逐行读取 JSONL，跳过不完整的末行。
 *
 * magpie 用 O_APPEND 追加写入，最后一行可能正在写。tokscale 版的做法是
 * 读到没有换行结尾的内容就丢弃 —— 这里保持一致，避免解析半条记录。
 */
async function* readLines(path) {
  let pending = Buffer.alloc(0);
  // createReadStream 对 ENOENT 不会同步抛出，错误走流的 error 事件，
  // 由 for await 重新抛出。所以 try/catch 必须包住整个迭代，不能只包创建。
  // 文件不存在是正常状态（magpie 还没产生第一次调用），安静返回。
  let stream;
  try {
    stream = createReadStream(path);
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      let index;
      while ((index = pending.indexOf(10, offset)) !== -1) {
        if (index - offset > MAX_LINE_BYTES) throw new Error('用量记录单行超过 1 MiB。');
        yield pending.subarray(offset, index).toString('utf8');
        offset = index + 1;
      }
      pending = pending.subarray(offset);
      if (pending.length > MAX_LINE_BYTES) throw new Error('用量记录单行超过 1 MiB。');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  // 未以换行结尾 → 正在写入中，丢弃。
  if (pending.length) yield null;
}

// 配置了 hostname 就用它（所有机器统一成一个值），否则用系统主机名。
export function resolveHostname(config) {
  if (config.hostname) return config.hostname;
  return osHostname().replace(/\.local$/, '');
}

// 收集本机 usage.jsonl 的原始记录。
async function* localRecords(config) {
  const host = resolveHostname(config);
  for await (const line of readLines(config.usageFile)) {
    if (line === null) continue;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      yield { record: null, hostname: host };
      continue;
    }
    yield { record, hostname: host };
  }
}

// 收集 usage-others/<id>/<day>.json。默认用那台机器自己的 name，
// 这样与它自己上报时的 hostname 一致，不会重复。
async function* otherRecords(config) {
  const forcedHost = config.hostname || null;
  let computers;
  try {
    computers = await readdir(config.othersDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of computers) {
    if (!entry.isDirectory()) continue;
    const dir = join(config.othersDir, entry.name);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      let payload;
      try {
        payload = JSON.parse(await readFile(join(dir, file), 'utf8'));
      } catch {
        // 单台机器某个文件坏了，不影响其他机器。
        yield { record: null, hostname: entry.name, broken: true };
        continue;
      }
      const host = forcedHost ?? (typeof payload?.name === 'string' && payload.name.trim()
        ? payload.name.trim().replace(/\.local$/, '')
        : entry.name);
      for (const call of payload?.calls ?? []) {
        yield { record: call, hostname: host };
      }
    }
  }
}

function yesterdayUTC(now) {
  const today = now.toISOString().slice(0, 10);
  return new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
}

/**
 * 聚合。
 *
 * @param {object} config configuration() 的返回值
 * @param {{now?: Date, date?: string, includeOthers?: boolean}} opts
 * @returns {Promise<{buckets: object[], diagnostics: object, hostname: string}>}
 */
export async function aggregate(config, { now = new Date(), date, includeOthers = config.includeOthers } = {}) {
  const enabled = new Set(enabledAgents(config.sources));
  const ineffective = ineffectiveAgents(config.sources);
  const through = yesterdayUTC(now);

  const diagnostics = {
    records: 0,
    malformed: 0,
    notEnabled: 0,
    unknownAgent: 0,
    unknownModel: 0,
    emptyTokens: 0,
    future: 0,
    beforeStart: 0,
    skippedTokens: 0,
    importedTokens: 0,
    brokenFiles: 0,
    byAgent: {},
  };

  if (enabled.size === 0) {
    return { buckets: [], diagnostics, hostname: resolveHostname(config), ineffective, otherComputers: [] };
  }

  /** @type {Map<string, object>} */
  const buckets = new Map();
  const otherComputerNames = new Set();

  const consume = ({ record, hostname, broken }) => {
    if (broken) {
      diagnostics.brokenFiles++;
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      diagnostics.malformed++;
      return;
    }
    diagnostics.records++;

    if (typeof record.t !== 'string') {
      diagnostics.malformed++;
      return;
    }
    const time = new Date(record.t);
    if (!Number.isFinite(time.getTime())) {
      diagnostics.malformed++;
      return;
    }
    const day = time.toISOString().slice(0, 10);
    if (day > through) {
      diagnostics.future++;
      return;
    }
    if (config.startDate && day < config.startDate) {
      diagnostics.beforeStart++;
      return;
    }
    if (date && day !== date) return;

    // 失败的调用：本地拒绝、或没有 provider 的 4xx/5xx。
    if (record.rejected === true) {
      diagnostics.emptyTokens++;
      return;
    }
    if (!record.provider && typeof record.status === 'number' && record.status >= 400) {
      diagnostics.emptyTokens++;
      return;
    }

    const mapping = lookupAgent(record.agent);
    if (!mapping) {
      diagnostics.unknownAgent++;
      return;
    }
    if (!enabled.has(record.agent.toLowerCase().trim().replace(/@wsl:.+$/, ''))) {
      diagnostics.notEnabled++;
      return;
    }

    let tokens;
    try {
      tokens = normalizeTokens(record);
    } catch {
      diagnostics.malformed++;
      return;
    }
    const total = tokenSum(tokens);
    if (total <= 0) {
      diagnostics.emptyTokens++;
      return;
    }

    // 模型：优先用 served（供应商实际应答的），退回 model。
    const model = String(record.served || record.model || '').trim();
    if (!model || model.length > 512) {
      diagnostics.unknownModel++;
      diagnostics.skippedTokens += total;
      return;
    }

    // magpie 不记录项目路径，统一用 unknown。这是与 vibe-usage 直读日志
    // 最大的语义差异 —— 文档里必须说明。
    const project = 'unknown';
    const bucketStart = roundToHalfHour(time);
    const key = `${mapping.source}|${model.slice(0, MODEL_MAX_LENGTH)}|${project}|${hostname}|${bucketStart}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        source: mapping.source,
        model: model.slice(0, MODEL_MAX_LENGTH),
        project: project.slice(0, PROJECT_MAX_LENGTH),
        hostname,
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
      };
      buckets.set(key, bucket);
    }
    for (const field of Object.keys(tokens)) bucket[field] += tokens[field];

    diagnostics.importedTokens += total;
    diagnostics.byAgent[record.agent] = (diagnostics.byAgent[record.agent] ?? 0) + 1;
    return true;
  };

  for await (const item of localRecords(config)) consume(item);
  if (includeOthers) {
    // 只有真的产出过桶的机器才计入 otherComputers —— 空文件或被全部
    // 过滤掉的机器不该出现在「本次包含 N 台其他机器」的警告里。
    for await (const item of otherRecords(config)) {
      if (consume(item) && item.hostname) otherComputerNames.add(item.hostname);
    }
  }

  // 收尾：补齐 totalTokens（vibe-usage 服务端用它做 >0 存活判断），
  // 并丢弃全零桶。
  const out = [];
  for (const bucket of buckets.values()) {
    const totalTokens =
      bucket.inputTokens +
      bucket.outputTokens +
      bucket.reasoningOutputTokens +
      bucket.cacheCreation5mTokens +
      bucket.cacheCreation1hTokens;
    if (totalTokens <= 0) continue;
    out.push({ ...bucket, totalTokens });
  }
  out.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart) || a.source.localeCompare(b.source));

  return {
    buckets: out,
    diagnostics,
    hostname: resolveHostname(config),
    ineffective,
    otherComputers: [...otherComputerNames],
  };
}

/**
 * 桶内容指纹，用于增量判断。
 * 与 vibe-usage 的 bucketHash() 语义一致：只哈希会变的数值字段。
 */
export function bucketHash(bucket) {
  return createHash('sha256')
    .update([
      bucket.inputTokens || 0,
      bucket.outputTokens || 0,
      bucket.cachedInputTokens || 0,
      bucket.reasoningOutputTokens || 0,
      bucket.totalTokens || 0,
      bucket.cacheCreation5mTokens || 0,
      bucket.cacheCreation1hTokens || 0,
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

export function bucketKey(bucket) {
  return `${bucket.source}|${bucket.model}|${bucket.project}|${bucket.hostname}|${bucket.bucketStart}`;
}

export { tokenSum };
