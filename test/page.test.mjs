import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { AGENT_SOURCES } from '../lib/sources.mjs';
import { buildCatalog, render } from '../scripts/build-page-catalog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 页面脚本是浏览器普通脚本（没有 export），用 vm 按同样方式加载，
// 这样测到的就是页面里真正会跑的那份代码。
async function loadView() {
  const source = await readFile(join(root, 'page', 'view.js'), 'utf8');
  const ctx = { console };
  ctx.globalThis = ctx;
  createContext(ctx);
  runInContext(source, ctx);
  return ctx.VibecafeView;
}

const { GROUPS, buildView, toOptions, summarize } = await loadView();

const catalog = {
  claude: { source: 'claude-code', vibeUsageReads: true, label: 'Claude Code' },
  codex: { source: 'codex', vibeUsageReads: true, label: 'Codex' },
  crush: { source: 'crush', vibeUsageReads: false, label: 'Crush' },
  zed: { source: null, vibeUsageReads: false, label: 'Zed' },
};

test('view.js 能在浏览器式环境里加载（无 export）', async () => {
  const source = await readFile(join(root, 'page', 'view.js'), 'utf8');
  assert.doesNotMatch(source, /^\s*export\s/m, '浏览器普通脚本不能有 export，否则整页白屏');
  assert.doesNotMatch(source, /^\s*import\s/m, '浏览器普通脚本不能有 import');
  const view = await loadView();
  assert.equal(typeof view.buildView, 'function');
});

test('三类分组正确', () => {
  const view = buildView({}, catalog);
  // vm 跨 realm，数组来自另一个原型链，比 JSON 值。
  assert.equal(JSON.stringify(view.groups.duplicate.map((x) => x.agent)), '["claude","codex"]');
  assert.equal(JSON.stringify(view.groups.exclusive.map((x) => x.agent)), '["crush"]');
  assert.equal(JSON.stringify(view.groups.blocked.map((x) => x.agent)), '["zed"]');
});

test('默认全部未开启', () => {
  const view = buildView({}, catalog);
  assert.equal(view.enabledCount, 0);
  for (const key of Object.keys(view.groups)) {
    for (const item of view.groups[key]) assert.equal(item.enabled, false);
  }
});

test('读取已有配置的开启状态', () => {
  const view = buildView({ claude: { enabled: true }, crush: { enabled: true } }, catalog);
  assert.equal(view.enabledCount, 2);
  assert.equal(view.groups.duplicate.find((x) => x.agent === 'claude').enabled, true);
  assert.equal(view.groups.exclusive[0].enabled, true);
});

test('toOptions 只输出已开启的项', () => {
  const view = buildView({ claude: { enabled: true } }, catalog);
  const opts = toOptions(view);
  // vm 跨 realm 的对象原型不同，deepStrictEqual 会失败，比 JSON 值。
  assert.equal(JSON.stringify(opts.sources), JSON.stringify({ claude: { enabled: true } }));
  assert.equal(opts.includeOthers, false);
});

test('toOptions 保留 includeOthers', () => {
  const view = buildView({}, catalog);
  assert.equal(toOptions(view, { includeOthers: true }).includeOthers, true);
});

test('保存后再读回来，状态一致（往返）', () => {
  const view = buildView({}, catalog);
  view.groups.duplicate[0].enabled = true;
  view.groups.exclusive[0].enabled = true;
  const opts = toOptions(view, { includeOthers: true });

  const again = buildView(opts.sources, catalog);
  assert.equal(again.groups.duplicate[0].enabled, true);
  assert.equal(again.groups.exclusive[0].enabled, true);
  assert.equal(again.enabledCount, 2);
});

test('摘要：全关时说明不会上传', () => {
  const view = buildView({}, catalog);
  assert.match(summarize(view), /不会上传任何数据/);
});

test('摘要：有重复项时明确提示', () => {
  const view = buildView({ claude: { enabled: true } }, catalog);
  assert.match(summarize(view), /重复计数/);
});

test('摘要：有无效项时明确提示', () => {
  const view = buildView({ zed: { enabled: true } }, catalog);
  assert.match(summarize(view), /开启无效/);
});

test('摘要：未登录时优先说明', () => {
  const view = buildView({}, catalog);
  assert.match(summarize(view, { signedIn: false }), /尚未登录/);
});

test('每组都有标题和说明文案', () => {
  for (const key of ['duplicate', 'exclusive', 'blocked']) {
    assert.ok(GROUPS[key].title, `${key} 缺标题`);
    assert.ok(GROUPS[key].hint, `${key} 缺说明`);
    assert.ok(GROUPS[key].tone, `${key} 缺 tone`);
  }
});

// ---- 生成物与源保持一致 ----

test('page/catalog.js 与 lib/sources.mjs 一致', async () => {
  const onDisk = await readFile(join(root, 'page', 'catalog.js'), 'utf8');
  const expected = render(buildCatalog(AGENT_SOURCES));
  assert.equal(
    onDisk,
    expected,
    'page/catalog.js 过期了，运行 npm run build:catalog 重新生成',
  );
});

test('生成的清单覆盖全部 agent', () => {
  const built = buildCatalog(AGENT_SOURCES);
  assert.equal(Object.keys(built).length, Object.keys(AGENT_SOURCES).length);
  for (const [agent, meta] of Object.entries(built)) {
    assert.equal(typeof meta.label, 'string', `${agent} 缺 label`);
    assert.equal(typeof meta.vibeUsageReads, 'boolean', `${agent} 的 vibeUsageReads 不是布尔值`);
    assert.ok(meta.source === null || typeof meta.source === 'string');
  }
});

// ---- 页面文件完整性 ----

test('页面 HTML 引用了 bridge 与全部脚本', async () => {
  const html = await readFile(join(root, 'page', 'index.html'), 'utf8');
  assert.match(html, /_magpie\/bridge\.js/, '必须加载 magpie 的 bridge');
  assert.match(html, /view\.js/);
  assert.match(html, /catalog\.js/);
  assert.match(html, /app\.js/);
});

test('页面没有内联脚本或外部资源（CSP 限制）', async () => {
  const html = await readFile(join(root, 'page', 'index.html'), 'utf8');
  const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/);
  assert.equal(inline, null, '页面不能有内联脚本，CSP 会拦');
  assert.doesNotMatch(html, /https?:\/\//, '页面不能引用外部资源，connect-src 是 none');
});

test('app.js 与 catalog.js 也没有模块语法', async () => {
  for (const file of ['app.js', 'catalog.js']) {
    const source = await readFile(join(root, 'page', file), 'utf8');
    assert.doesNotMatch(source, /^\s*(export|import)\s/m, `${file} 不能有模块语法`);
  }
});

test('勾选后摘要立刻更新（不用 buildView 的快照）', () => {
  const view = buildView({}, catalog);
  assert.match(summarize(view), /未开启任何工具/);

  // 模拟用户勾选
  view.groups.duplicate[0].enabled = true;
  view.groups.exclusive[0].enabled = true;

  const text = summarize(view);
  assert.match(text, /已开启 2 个工具/, '摘要必须反映最新勾选状态，不能用旧快照');
  assert.match(text, /1 个会与 vibe-usage 重复计数/);
});
