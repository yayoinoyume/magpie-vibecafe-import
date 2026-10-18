#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { configuration, enabledAgents, ineffectiveAgents } from './lib/config.mjs';
import { classifyAgents, AGENT_SOURCES } from './lib/sources.mjs';
import { aggregate } from './lib/aggregate.mjs';
import { run } from './lib/worker.mjs';
import { fetchAccount } from './lib/transport.mjs';
import { credentials } from './lib/config.mjs';

const HELP = `magpie-vibecafe-import — 把 magpie 用量导入 vibecafe.ai

用法：
  magpie-vibecafe-import sources              列出所有 agent 及其映射状态
  magpie-vibecafe-import status               查看配置与登录状态
  magpie-vibecafe-import preview [--date D]   预览将要上传的桶，不联网
  magpie-vibecafe-import submit  [--date D]   立即上传（增量）
  magpie-vibecafe-import account              查看密钥绑定的账号

参数：
  --magpie-dir <path>   magpie 配置目录（默认 ~/.config/magpie）
  --date <YYYY-MM-DD>   只处理这一天（UTC）
  --include-others      把其他机器同步来的用量也算进来
  --start-date <D>      忽略该日期之前的历史
  --enable a,b,c        临时开启这些 agent（不写入配置，仅本次生效）
  --json                以 JSON 输出结果

环境变量：
  VIBECAFE_API_KEY      覆盖已保存的密钥
  VIBECAFE_API_URL      覆盖 API 地址
  MAGPIE_DIR            同上 --magpie-dir
`;

function fail(message) {
  console.error('错误：' + message);
  process.exit(1);
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function printDiagnostics(d) {
  const rows = [
    ['读取记录', d.records],
    ['失败/空记录', d.emptyTokens],
    ['未开启的工具', d.notEnabled],
    ['未知工具', d.unknownAgent],
    ['未知模型', d.unknownModel],
    ['格式错误', d.malformed],
    ['今天及以后（跳过）', d.future],
    ['早于 startDate', d.beforeStart],
    ['损坏的跨机文件', d.brokenFiles],
  ].filter(([, v]) => v > 0);

  if (rows.length === 0) return;
  console.log('\n诊断：');
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(18)} ${formatNumber(value)}`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'magpie-dir': { type: 'string' },
        'date': { type: 'string' },
        'include-others': { type: 'boolean' },
        'start-date': { type: 'string' },
        // 逗号分隔的 agent 列表，供 CLI 调试用；插件本身从 options.sources 读。
        'enable': { type: 'string' },
        'json': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    fail(error.message);
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const command = positionals[0];

  if (command === 'sources') {
    const { duplicated, exclusive, unmappable } = classifyAgents();
    if (values.json) {
      console.log(JSON.stringify({ duplicated, exclusive, unmappable }, null, 2));
      return;
    }
    console.log('可导入，但 vibe-usage 自己也会读（同时开启会重复计数）：');
    for (const a of duplicated) console.log(`  ${a.padEnd(20)} → ${AGENT_SOURCES[a].source}`);
    console.log('\n可导入，vibe-usage 不读（推荐开启）：');
    for (const a of exclusive) console.log(`  ${a.padEnd(20)} → ${AGENT_SOURCES[a].source}`);
    console.log('\nvibe-usage 未注册 source（开启也导不进去）：');
    console.log('  ' + unmappable.join(', '));
    return;
  }

  let config;
  try {
    config = configuration({
      magpieDir: values['magpie-dir'],
      startDate: values['start-date'],
      includeOthers: values['include-others'] === true ? true : undefined,
      sources: values.enable
        ? Object.fromEntries(values.enable.split(',').map((a) => [a.trim(), true]).filter(([a]) => a))
        : undefined,
    });
  } catch (error) {
    fail(error.message);
  }

  if (command === 'status') {
    const enabled = enabledAgents(config.sources);
    const ineffective = ineffectiveAgents(config.sources);
    const auth = await credentials(config, { allowMissingAccount: true });
    const status = {
      magpieDir: config.magpieDir,
      usageFile: config.usageFile,
      othersDir: config.othersDir,
      includeOthers: config.includeOthers,
      apiUrl: config.apiUrl,
      signedIn: Boolean(auth.token),
      enabled,
      ineffective,
    };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`magpie 目录     ${status.magpieDir}`);
    console.log(`用量文件        ${status.usageFile}`);
    console.log(`跨机目录        ${status.othersDir}${status.includeOthers ? '（已启用）' : '（未启用）'}`);
    console.log(`API 地址        ${status.apiUrl}`);
    console.log(`登录状态        ${status.signedIn ? '已登录' : '未登录'}`);
    console.log(`已开启工具      ${enabled.length ? enabled.join(', ') : '（无）'}`);
    if (ineffective.length) {
      console.log(`开启但无效      ${ineffective.join(', ')} — vibe-usage 未注册这些 source`);
    }
    return;
  }

  if (command === 'account') {
    const auth = await credentials(config, { allowMissingAccount: true });
    if (!auth.token) fail('尚未登录。');
    const account = await fetchAccount(config, auth.token);
    if (!account) {
      console.log('无法读取账号信息（服务端可能不支持，或网络失败）。密钥本身可能仍然有效。');
      return;
    }
    console.log(`账号：${account.handle}${account.name ? `（${account.name}）` : ''}`);
    return;
  }

  if (command === 'preview') {
    const date = values.date;
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date 必须是 YYYY-MM-DD。');
    let snapshot;
    try {
      snapshot = await aggregate(config, { date });
    } catch (error) {
      fail(error.message);
    }
    if (values.json) {
      console.log(JSON.stringify({ buckets: snapshot.buckets, diagnostics: snapshot.diagnostics }, null, 2));
      return;
    }
    if (snapshot.buckets.length === 0) {
      console.log('没有可上传的桶。');
      printDiagnostics(snapshot.diagnostics);
      console.log('\n提示：默认所有 agent 都是关闭的，先运行 `magpie-vibecafe-import sources` 看怎么开。');
      return;
    }
    console.log(`共 ${snapshot.buckets.length} 个桶：\n`);
    console.log('  时间(UTC)            source          model                    tokens');
    for (const b of snapshot.buckets.slice(0, 50)) {
      console.log(
        `  ${b.bucketStart.slice(0, 16).replace('T', ' ')}` +
        `  ${b.source.padEnd(15)}` +
        `  ${b.model.slice(0, 24).padEnd(24)}` +
        `  ${formatNumber(b.totalTokens)}`,
      );
    }
    if (snapshot.buckets.length > 50) console.log(`  … 还有 ${snapshot.buckets.length - 50} 个`);
    printDiagnostics(snapshot.diagnostics);
    return;
  }

  if (command === 'submit') {
    const date = values.date;
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date 必须是 YYYY-MM-DD。');
    let result;
    try {
      result = await run(config, { date, onProgress: (done, total) => {
        if (total > 1) process.stderr.write(`\r  上传中 ${done}/${total}`);
      } });
    } catch (error) {
      fail(error.message);
    }
    if (totalOutputCleanup()) process.stderr.write('\r\x1b[K');

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const messages = {
      'nothing-enabled': '没有开启任何 agent，未上传。',
      'not-configured': '尚未登录，未上传。',
      'unchanged': '没有新增或变化的数据。',
      'auth-blocked': '认证被拒绝：' + (result.message ?? ''),
      'failed': '上传失败：' + (result.message ?? ''),
      'complete': `已上传 ${formatNumber(result.submitted)} 个桶。`,
      'preview': '',
    };
    console.log(messages[result.status] ?? result.status);

    if (result.unchanged) console.log(`  跳过未变化 ${formatNumber(result.unchanged)} 个桶`);
    if (result.regressed) console.log(`  跳过变小 ${formatNumber(result.regressed)} 个桶（服务端会保留旧值）`);
    for (const w of result.warnings ?? []) console.log('  注意：' + w);
    if (result.diagnostics) printDiagnostics(result.diagnostics);

    if (['auth-blocked', 'failed'].includes(result.status)) process.exit(1);
    return;
  }

  fail(`未知命令：${command}。运行 --help 查看用法。`);
}

function totalOutputCleanup() {
  return process.stderr.isTTY;
}

main().catch((error) => fail(error.message));
