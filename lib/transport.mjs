import { gzipSync } from 'node:zlib';

// vibe-usage 的上传接口。与 vibe-usage 自己的 api.js 保持同一契约：
//   POST {apiUrl}/api/usage/ingest
//   Authorization: Bearer <vbu_...>
//   Content-Encoding: gzip
//   body: { buckets: [...], client?: {...} }
//
// 响应里可能出现 dropped.unknownSources —— 那是 source 未在服务端注册时
// 的**静默丢弃**，必须让用户看到，否则他会以为数据已经上去了。

export class IngestError extends Error {
  constructor(message, kind, retryAfterMs = 0) {
    super(message);
    this.kind = kind; // 'auth' | 'retry' | 'permanent'
    this.retryAfterMs = retryAfterMs;
  }
}

const BATCH_SIZE = 100;

/**
 * 把桶分批后逐个上传。
 *
 * @param {object} config
 * @param {string} token
 * @param {object[]} buckets
 * @param {{onBatch?: (done: number, total: number) => void}} opts
 * @returns {Promise<{
 *   sent: number,
 *   ingested: number,
 *   dropped: {buckets: number, unknownSources: string[], models: string[]},
 *   silent: {buckets: number, models: string[]},
 *   protected: number,
 *   batches: number,
 * }>}
 */
export async function uploadBuckets(config, token, buckets, { onBatch } = {}) {
  const result = {
    sent: buckets.length,
    ingested: 0,
    dropped: { buckets: 0, unknownSources: [], models: [] },
    // 服务端「收下了」但没落库的桶：ingested 少于发送量，且 dropped 没解释这部分。
    // 实测发现模型名未收录在价格表时会这样静默消失。
    silent: { buckets: 0, models: [] },
    protected: 0,
    batches: 0,
  };

  const unknownSources = new Set();
  const droppedModels = new Set();
  const silentModels = new Set();
  const total = Math.ceil(buckets.length / BATCH_SIZE) || 0;

  for (let i = 0; i < total; i++) {
    const batch = buckets.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const reply = await sendBatch(config.apiUrl, token, batch);

    result.batches++;

    const reported = Number(reply?.ingested);
    const ingested = Number.isFinite(reported) ? reported : batch.length;
    result.ingested += ingested;

    const droppedBuckets = Number(reply?.dropped?.buckets) || 0;
    if (reply?.dropped) {
      result.dropped.buckets += droppedBuckets;
      for (const s of reply.dropped.unknownSources ?? []) unknownSources.add(s);
      for (const m of reply.dropped.unknownModels ?? []) droppedModels.add(m);
    }

    // 未被 dropped 解释的差额 = 静默丢弃。服务端对价格表里没有的模型
    // 会返回 200 且计入 ingested，但数据实际不落库（已实测确认）。
    const unexplained = batch.length - ingested - droppedBuckets;
    if (unexplained > 0) {
      result.silent.buckets += unexplained;
      // 无法确定具体是哪个桶，把这一批的模型都列出来供排查。
      for (const b of batch) silentModels.add(b.model);
    }

    result.protected += Number(reply?.protected?.buckets) || 0;

    onBatch?.(i + 1, total);
  }

  result.dropped.unknownSources = [...unknownSources].sort();
  result.dropped.models = [...droppedModels].sort();
  result.silent.models = [...silentModels].sort();
  return result;
}

async function sendBatch(apiUrl, token, batch) {
  const payload = { buckets: batch };
  const raw = Buffer.from(JSON.stringify(payload));
  const body = gzipSync(raw);

  let response;
  try {
    response = await fetch(new URL('/api/usage/ingest', apiUrl), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        authorization: `Bearer ${token}`,
      },
      body,
    });
  } catch {
    throw new IngestError('Vibecafe 网络失败或超时，同一批桶可以安全重试。', 'retry');
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new IngestError('Vibecafe 认证被拒绝。请重新登录或更换 API key。', 'auth');
  }
  if (response.status === 429 || response.status >= 500) {
    const header = response.headers.get('retry-after');
    const parsed = header && /^\d+(?:\.\d+)?$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header || '') - Date.now();
    await response.body?.cancel().catch(() => {});
    throw new IngestError(
      `Vibecafe 暂时不可用（HTTP ${response.status}）。`,
      'retry',
      Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new IngestError(
      `Vibecafe 拒绝了这批数据（HTTP ${response.status}）${text ? '：' + text.slice(0, 200) : ''}`,
      'permanent',
    );
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new IngestError('Vibecafe 响应中断，同一批桶可以安全重试。', 'retry');
  }
  if (text.length > 1024 * 1024) {
    throw new IngestError('Vibecafe 响应过大，需要核对兼容性。', 'permanent');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new IngestError('Vibecafe 返回了非 JSON 响应，需要核对兼容性。', 'permanent');
  }
}

/** 读取账号信息，用于登录后确认密钥绑对了账号。失败不阻塞主流程。 */
export async function fetchAccount(config, token) {
  try {
    const response = await fetch(new URL('/api/usage?days=1&bucketsOnly=true', config.apiUrl), {
      signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const data = await response.json();
    const account = data?.account;
    if (account && typeof account.handle === 'string') {
      return { handle: account.handle, name: account.name ?? null };
    }
    return null;
  } catch {
    return null;
  }
}
