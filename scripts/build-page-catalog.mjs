#!/usr/bin/env node
// 从 lib/sources.mjs 生成 page/catalog.js。
//
// 页面跑在沙盒 iframe 里，不能 import 模块、不能联网，所以清单必须
// 预先内联成一个普通脚本。这个脚本保证页面和插件读的是同一份事实。
//
// 改了 lib/sources.mjs 之后重新跑：npm run build:catalog
// 测试会检查产物是否与源一致，忘了跑会失败。

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AGENT_SOURCES } from '../lib/sources.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'page', 'catalog.js');

/** 只保留页面要用的字段，避免把内部注释和多余属性带进去。 */
export function buildCatalog(source = AGENT_SOURCES) {
  const out = {};
  for (const [agent, meta] of Object.entries(source)) {
    out[agent] = {
      source: meta.source,
      vibeUsageReads: meta.vibeUsageReads === true,
      label: meta.label,
    };
  }
  return out;
}

export function render(catalog) {
  return `// 由 scripts/build-page-catalog.mjs 从 lib/sources.mjs 生成，请勿手改。
// 重新生成：npm run build:catalog
globalThis.VIBECAFE_CATALOG = ${JSON.stringify(catalog, null, 2)};
`;
}

async function main() {
  const catalog = buildCatalog();
  await writeFile(target, render(catalog), 'utf8');
  const n = Object.keys(catalog).length;
  console.log(`page/catalog.js: ${n} 个 agent`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
