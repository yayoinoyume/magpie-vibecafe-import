import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import plugin from '../index.mjs';

async function boot(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibecafe-plugin-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const magpieDir = join(dir, 'magpie');
  await mkdir(magpieDir, { recursive: true });
  await writeFile(join(magpieDir, 'usage.jsonl'), '');

  const logs = [];
  const input = {
    project: { id: 'magpie' },
    directory: magpieDir,
    client: { app: { log: async ({ body }) => logs.push(body) } },
  };

  const hooks = await plugin.server(input, { autoUpload: false, ...options });
  return { hooks, logs, magpieDir };
}

test('插件导出形状符合 magpie 契约', () => {
  assert.equal(typeof plugin.id, 'string');
  assert.equal(typeof plugin.server, 'function');
});

test('不在 magpie 里运行时报错，不静默降级', async () => {
  await assert.rejects(
    () => plugin.server({ project: { id: 'other' } }, {}),
    /需要读取 magpie/,
  );
});

test('不注册 config.provider —— 供应商列表里不该出现假条目', async (t) => {
  const { hooks } = await boot(t);
  const config = { provider: {} };
  await hooks.config(config);

  assert.deepEqual(
    Object.keys(config.provider),
    [],
    '本插件不提供模型，注册 provider 会污染供应商列表',
  );
});

test('保留 auth hook —— 登录入口靠它，不靠 config.provider', async (t) => {
  const { hooks } = await boot(t);
  assert.ok(hooks.auth, '没有 auth hook 用户就没法登录');
  assert.equal(hooks.auth.provider, 'vibecafe-import');
  assert.equal(hooks.auth.methods.length, 1);
  assert.equal(hooks.auth.methods[0].type, 'api');
});

test('已有 provider 配置不会被清空', async (t) => {
  const { hooks } = await boot(t);
  const config = { provider: { existing: { name: 'Existing', models: {} } } };
  await hooks.config(config);

  assert.deepEqual(Object.keys(config.provider), ['existing'], '不能动别的插件的 provider');
});

test('未开启任何工具时明确告知不会上传', async (t) => {
  const { hooks, logs } = await boot(t);
  await hooks.config({});
  await new Promise((r) => setTimeout(r, 50));

  const messages = logs.map((l) => l.message).join(' ');
  assert.match(messages, /不会上传任何数据/);
});

test('开启无效 source 时逐条告警', async (t) => {
  const { hooks, logs } = await boot(t, { sources: { zed: true, claude: true } });
  await hooks.config({});
  await new Promise((r) => setTimeout(r, 50));

  const warns = logs.filter((l) => l.level === 'warn').map((l) => l.message).join(' ');
  assert.match(warns, /zed/);
  assert.match(warns, /未注册/);
  assert.match(warns, /claude/);
  assert.match(warns, /重复/);
});

test('autoUpload 为 false 时不启动调度器', async (t) => {
  const { hooks, logs } = await boot(t, { autoUpload: false, sources: { claude: true } });
  await hooks.config({});
  await new Promise((r) => setTimeout(r, 80));

  const messages = logs.map((l) => l.message).join(' ');
  assert.match(messages, /自动上传已被配置关闭/);
});
