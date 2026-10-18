import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { AGENT_SOURCES } from './sources.mjs';

export const AUTH_PROVIDER = 'vibecafe-import';
export const VERSION = '0.1.0';

/**
 * 默认配置：所有工具一律关闭。
 *
 * 这是刻意的。新用户装上插件后不应有任何数据被上传；想导哪个工具，
 * 自己去 plugins.json 的 options.sources 里打开。
 */
export function defaultSources() {
  /** @type {Record<string, {source: string|null, enabled: boolean, note: string}>} */
  const out = {};
  for (const [agent, mapping] of Object.entries(AGENT_SOURCES)) {
    if (mapping.source === null) {
      out[agent] = {
        source: null,
        enabled: false,
        note: `vibe-usage 未注册 source，开启后数据会被服务端丢弃`,
      };
    } else if (mapping.vibeUsageReads) {
      out[agent] = {
        source: mapping.source,
        enabled: false,
        note: `vibe-usage 会自己读取该工具的日志，同时开启会重复计数`,
      };
    } else {
      out[agent] = {
        source: mapping.source,
        enabled: false,
        note: `vibe-usage 不读取该工具，可安全开启`,
      };
    }
  }
  return out;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验并规范化用户传入的 sources 配置。
 *
 * 接受两种写法：
 *   { "claude": true }                      —— 简写，true = 用映射表的 source
 *   { "claude": { "enabled": true } }       —— 完整写法
 *
 * 未知 agent id 直接报错，避免用户以为打开了实际没生效。
 */
export function normalizeSources(raw) {
  if (raw === undefined) return defaultSources();
  if (!isPlainObject(raw)) throw new Error('sources 必须是对象。');

  const out = defaultSources();
  for (const [agent, value] of Object.entries(raw)) {
    const key = agent.toLowerCase().trim();
    if (!(key in out)) {
      throw new Error(
        `未知的 agent: ${JSON.stringify(agent)}。` +
        `可用值见文档的「支持的 agent」一节，或运行 magpie-vibecafe-import sources 查看。`,
      );
    }
    if (typeof value === 'boolean') {
      out[key].enabled = value;
    } else if (isPlainObject(value)) {
      if (value.enabled !== undefined) {
        if (typeof value.enabled !== 'boolean') throw new Error(`sources.${key}.enabled 必须是布尔值。`);
        out[key].enabled = value.enabled;
      }
      // 允许用户显式覆盖 source，用于上游注册了新名字的场景。
      if (value.source !== undefined) {
        if (typeof value.source !== 'string' || !value.source.trim()) {
          throw new Error(`sources.${key}.source 必须是非空字符串。`);
        }
        out[key].source = value.source.trim();
      }
    } else {
      throw new Error(`sources.${key} 必须是布尔值或对象。`);
    }
  }
  return out;
}

/** 已开启且确实有 source 的 agent 列表。 */
export function enabledAgents(sources) {
  return Object.entries(sources)
    .filter(([, v]) => v.enabled && v.source !== null)
    .map(([agent]) => agent)
    .sort();
}

/** 用户开了但没有 source、实际导不进去的 agent —— 必须显式告警。 */
export function ineffectiveAgents(sources) {
  return Object.entries(sources)
    .filter(([, v]) => v.enabled && v.source === null)
    .map(([agent]) => agent)
    .sort();
}

export function configuration(options = {}, directory) {
  if (!isPlainObject(options)) throw new Error('插件 options 必须是对象。');

  for (const key of ['token', 'apiKey', 'apiToken', 'key', 'manualKey']) {
    if (key in options) {
      throw new Error('不要在插件 options 里存密钥。请用插件登录，或设置 VIBECAFE_API_KEY 环境变量。');
    }
  }

  const env = process.env;
  const configHome = isAbsolute(env.XDG_CONFIG_HOME || '') ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  const path = (value, fallback) => {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error('配置的路径必须是非空字符串。');
    }
    return resolve(value ?? fallback);
  };

  const magpieDir = path(options.magpieDir ?? env.MAGPIE_DIR, directory || join(configHome, 'magpie'));
  const sources = normalizeSources(options.sources);

  // 是否把其他机器同步过来的用量（usage-others/）也算进来。
  // 默认关闭：那台机器如果自己也装了插件，两边都会上报。
  let includeOthers = options.includeOthers;
  if (includeOthers !== undefined && typeof includeOthers !== 'boolean') {
    throw new Error('includeOthers 必须是布尔值。');
  }
  if (env.VIBECAFE_INCLUDE_OTHERS !== undefined) {
    if (!['true', 'false'].includes(env.VIBECAFE_INCLUDE_OTHERS)) {
      throw new Error('VIBECAFE_INCLUDE_OTHERS 必须是 true 或 false。');
    }
    includeOthers = env.VIBECAFE_INCLUDE_OTHERS === 'true';
  }

  let autoUpload = options.autoUpload;
  if (autoUpload !== undefined && typeof autoUpload !== 'boolean') {
    throw new Error('autoUpload 必须是布尔值。');
  }
  if (env.VIBECAFE_AUTO_UPLOAD !== undefined) {
    if (!['true', 'false'].includes(env.VIBECAFE_AUTO_UPLOAD)) {
      throw new Error('VIBECAFE_AUTO_UPLOAD 必须是 true 或 false。');
    }
    autoUpload = env.VIBECAFE_AUTO_UPLOAD === 'true';
  }

  // 历史起点。不设则从最早记录开始。
  const startDate = options.startDate ?? env.VIBECAFE_START_DATE;
  if (startDate !== undefined && !validDate(startDate)) {
    throw new Error('startDate 必须是真实的 YYYY-MM-DD 日期。');
  }

  const apiUrl = (options.apiUrl ?? env.VIBECAFE_API_URL ?? 'https://vibecafe.ai').replace(/\/+$/, '');
  try {
    new URL(apiUrl);
  } catch {
    throw new Error('apiUrl 不是合法 URL。');
  }

  const account = options.account ?? env.VIBECAFE_ACCOUNT;
  if (account !== undefined && (typeof account !== 'string' || !(account === AUTH_PROVIDER || account.startsWith(AUTH_PROVIDER + '#')))) {
    throw new Error('无效的 Vibecafe 账号选择器。');
  }

  return {
    magpieDir,
    apiUrl,
    sources,
    includeOthers: includeOthers === true,
    autoUpload,
    startDate,
    account,
    usageFile: path(options.usageFile ?? env.VIBECAFE_USAGE_FILE, join(magpieDir, 'usage.jsonl')),
    othersDir: path(options.othersDir ?? env.VIBECAFE_OTHERS_DIR, join(magpieDir, 'usage-others')),
    stateDir: path(options.stateDir ?? env.VIBECAFE_STATE_DIR, join(magpieDir, 'vibecafe-import')),
  };
}

async function readJSON(path, optional = false) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw new Error('无法读取合法 JSON：' + path, { cause: error });
  }
}

/**
 * 读取 API 密钥。
 *
 * 优先级：环境变量 > magpie 保存的登录凭证。
 * 与 tokscale 版一致：环境变量存在时覆盖已保存的密钥。
 */
export async function credentials(config, { allowMissingAccount = false } = {}) {
  const envKey = process.env.VIBECAFE_API_KEY;
  if (envKey !== undefined) {
    return { token: checkedToken(envKey), source: 'environment' };
  }

  const auth = await readJSON(join(config.magpieDir, 'plugin-auth.json'), true);
  if (auth === undefined) return {};
  if (!isPlainObject(auth)) throw new Error('magpie 登录凭证文件格式无效。');

  let entries = Object.entries(auth).filter(([id]) => id === AUTH_PROVIDER || id.startsWith(AUTH_PROVIDER + '#'));
  if (config.account) entries = entries.filter(([id]) => id === config.account);
  if (entries.length > 1) throw new Error('存在多个 Vibecafe 账号，请显式设置 account。');
  if (!entries.length) {
    if (config.account && !allowMissingAccount) throw new Error('指定的 Vibecafe 账号不存在。');
    return {};
  }

  const value = entries[0][1];
  if (value?.type !== 'api') throw new Error('Vibecafe 登录方式必须是 API key。');
  return { token: checkedToken(value.key), source: 'saved', account: entries[0][0] };
}

function checkedToken(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /\s/.test(value)) {
    throw new Error('无效的 Vibecafe API key。请重新登录，或更新 VIBECAFE_API_KEY。');
  }
  return value;
}
