import test from 'node:test';
import assert from 'node:assert/strict';

import {
  configuration, defaultSources, enabledAgents, ineffectiveAgents, normalizeSources,
} from '../lib/config.mjs';

test('默认配置：所有 agent 一律关闭', () => {
  const sources = defaultSources();
  for (const [agent, value] of Object.entries(sources)) {
    assert.equal(value.enabled, false, `${agent} 默认必须关闭`);
  }
  assert.equal(enabledAgents(sources).length, 0);
});

test('默认配置的备注区分三类情况', () => {
  const sources = defaultSources();
  // 会重复
  assert.match(sources.claude.note, /重复/);
  // 无 source
  assert.match(sources.zed.note, /未注册/);
  assert.equal(sources.zed.source, null);
});

test('简写写法：{ claude: true }', () => {
  const sources = normalizeSources({ claude: true });
  assert.equal(sources.claude.enabled, true);
  assert.equal(sources.claude.source, 'claude-code');
  assert.equal(sources.codex.enabled, false, '没提到的保持关闭');
});

test('完整写法：{ claude: { enabled: true } }', () => {
  const sources = normalizeSources({ claude: { enabled: true } });
  assert.equal(sources.claude.enabled, true);
});

test('可以覆盖 source 名（上游注册新名字时用）', () => {
  const sources = normalizeSources({ claude: { enabled: true, source: 'magpie-claude' } });
  assert.equal(sources.claude.source, 'magpie-claude');
});

test('未知 agent 直接报错，不静默忽略', () => {
  assert.throws(() => normalizeSources({ 不存在的工具: true }), /未知的 agent/);
});

test('enabled 必须是布尔值', () => {
  assert.throws(() => normalizeSources({ claude: { enabled: 'yes' } }), /必须是布尔值/);
});

test('enabledAgents 排除没有 source 的条目', () => {
  const sources = normalizeSources({ zed: true, claude: true });
  assert.deepEqual(enabledAgents(sources), ['claude'], 'zed 没有 source，不算有效');
  assert.deepEqual(ineffectiveAgents(sources), ['zed'], '但要能识别出来告警');
});

test('禁止在 options 里存密钥', () => {
  assert.throws(() => configuration({ apiKey: 'vbu_x' }), /不要在插件 options 里存密钥/);
  assert.throws(() => configuration({ token: 'vbu_x' }), /不要在插件 options 里存密钥/);
});

test('includeOthers 默认关闭', () => {
  const config = configuration({}, '/tmp/magpie');
  assert.equal(config.includeOthers, false);
});

test('startDate 必须是真实日期', () => {
  assert.throws(() => configuration({ startDate: '2026-02-30' }), /真实的 YYYY-MM-DD/);
  assert.doesNotThrow(() => configuration({ startDate: '2026-02-28' }, '/tmp/magpie'));
});

test('apiUrl 去掉末尾斜杠', () => {
  const config = configuration({ apiUrl: 'https://example.test/' }, '/tmp/magpie');
  assert.equal(config.apiUrl, 'https://example.test');
});

test('默认路径基于 magpie 目录', () => {
  const config = configuration({}, '/custom/magpie');
  assert.equal(config.usageFile, '/custom/magpie/usage.jsonl');
  assert.equal(config.othersDir, '/custom/magpie/usage-others');
  assert.equal(config.stateDir, '/custom/magpie/vibecafe-import');
});
