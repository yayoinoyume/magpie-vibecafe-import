import { aggregate, bucketHash, bucketKey } from './aggregate.mjs';
import { credentials, enabledAgents, ineffectiveAgents } from './config.mjs';
import { diffBuckets, loadState, pruneState, recordUploaded, saveState, stateIdentity } from './state.mjs';
import { IngestError, uploadBuckets } from './transport.mjs';

/**
 * 执行一次完整的上传流程。
 *
 * 流程顺序是刻意的：
 *   1. 先查配置 —— 没开任何 agent 就直接返回，不读文件不联网
 *   2. 再读凭证 —— 没登录就返回，不浪费 IO
 *   3. 聚合 → 增量比对 → 分批上传 → 逐批记账
 *
 * @param {object} config
 * @param {{now?: Date, dryRun?: boolean, onProgress?: Function}} opts
 */
export async function run(config, { now = new Date(), date, dryRun = false, onProgress } = {}) {
  const enabled = enabledAgents(config.sources);
  const ineffective = ineffectiveAgents(config.sources);

  // 用户开了但导不进去的 agent —— 必须每次都提，否则他永远不知道为什么没数据。
  const warnings = ineffective.map(
    (agent) => `${agent}: 已在配置中开启，但 vibe-usage 未注册该工具的 source，数据会被服务端丢弃。`,
  );

  if (enabled.length === 0) {
    return {
      status: 'nothing-enabled',
      message: '没有开启任何 agent。请在插件选项的 sources 里把想导入的工具设为 true。',
      warnings,
      imported: 0,
      submitted: 0,
    };
  }

  const auth = await credentials(config, { allowMissingAccount: true });
  if (!auth.token) {
    return {
      status: 'not-configured',
      message: '尚未登录。请在 magpie 里登录 Vibecafe Import，或设置 VIBECAFE_API_KEY。',
      warnings,
      imported: 0,
      submitted: 0,
    };
  }

  const snapshot = await aggregate(config, { now, date });
  const identity = stateIdentity({ apiUrl: config.apiUrl, token: auth.token });
  const state = await loadState(config, identity);

  const result = {
    status: 'complete',
    enabled,
    warnings: [...warnings],
    diagnostics: snapshot.diagnostics,
    imported: snapshot.buckets.length,
    submitted: 0,
    unchanged: 0,
    regressed: 0,
    dropped: { buckets: 0, unknownSources: [] },
    protected: 0,
    identityChanged: state.identityChanged === true,
  };

  if (state.identityChanged) {
    result.warnings.push('检测到上传账号已更换，本次会全量重传本地历史。');
  }

  const diff = diffBuckets(snapshot.buckets, state, bucketKey, bucketHash);

  result.unchanged = diff.unchanged.length;
  result.regressed = diff.regressed.length;

  // 清理已消失的桶。只清本次解析过的 source。
  const okSources = new Set(snapshot.buckets.map((b) => b.source));
  const liveKeys = new Set(snapshot.buckets.map(bucketKey));
  pruneState(state, liveKeys, okSources);

  if (diff.changed.length === 0) {
    if (!dryRun) await saveState(config, state, identity);
    result.status = 'unchanged';
    return result;
  }

  if (dryRun) {
    result.status = 'preview';
    result.submitted = diff.changed.length;
    return result;
  }

  try {
    const upload = await uploadBuckets(
      config,
      auth.token,
      diff.changed.map((c) => c.bucket),
      { onBatch: (done, total) => onProgress?.(done, total) },
    );

    result.submitted = upload.ingested;
    result.dropped = upload.dropped;
    result.protected = upload.protected;

    // 逐桶记账。被服务端丢弃的 source 不记账 —— 等上游注册后下次重传。
    const droppedSources = new Set(upload.dropped.unknownSources);
    for (const item of diff.changed) {
      if (droppedSources.has(item.bucket.source)) continue;
      recordUploaded(state, item.key, item.hash, item.bucket.totalTokens);
    }
    await saveState(config, state, identity);

    if (upload.dropped.buckets > 0) {
      result.warnings.push(
        `${upload.dropped.buckets} 个桶被服务端丢弃` +
        (upload.dropped.unknownSources.length
          ? `（未注册的 source：${upload.dropped.unknownSources.join(', ')}）。` +
            `这些数据不会出现在面板上；等 vibe-usage 上游注册该 source 后，重新运行即可补传。`
          : '。'),
      );
    }
    if (upload.protected > 0) {
      result.warnings.push(
        `服务端保留了 ${upload.protected} 个更大的已有桶（本次快照更小，未覆盖）。` +
        `这通常意味着同一份数据被 vibe-usage 自己上传过。`,
      );
    }

    return result;
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    // 失败的批次不记账，下次重传。
    await saveState(config, state, identity);
    return {
      ...result,
      status: error.kind === 'auth' ? 'auth-blocked' : 'failed',
      message: error.message,
    };
  }
}
