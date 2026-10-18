// magpie agent id → vibe-usage source 映射表。
//
// 两个事实决定了这张表的样子：
//
// 1. vibe-usage 服务端只接受 USAGE_SOURCES 里注册过的 source，未注册的会被
//    静默丢弃（返回 200，只在客户端打一行 dropped）。所以 "mappable: false"
//    的条目即使开启也导不进去 —— 插件必须提前告诉用户，而不是让他白开。
//
// 2. vibe-usage 自己会读 ~/.claude、~/.codex 等原始日志。凡是两边都能读到的
//    工具，同时开启就会重复计数。"vibeUsageReads" 记录这个事实，用于在日志
//    和文档里给出明确警告。
//
// 这张表对应 magpie 源码 internal/agent/agents.go 的 builtins() 与
// internal/agent/*.go 里各 Agent 的 ID 字段。新增 agent 时同步这里。

/**
 * @typedef {object} SourceMapping
 * @property {string|null} source  vibe-usage 的 source 名；null 表示无对应
 * @property {boolean} vibeUsageReads  vibe-usage 是否自己直读该工具的日志
 * @property {string} label  人类可读名称
 */

/** @type {Record<string, SourceMapping>} */
export const AGENT_SOURCES = {
  // ---- 有对应 source，且 vibe-usage 自己会读（同时开启 = 重复计数）----
  claude: { source: 'claude-code', vibeUsageReads: true, label: 'Claude Code' },
  'claude-desktop': { source: 'claude-code', vibeUsageReads: true, label: 'Claude Desktop' },
  'claude-science': { source: 'claude-code', vibeUsageReads: true, label: 'Claude Science' },
  codex: { source: 'codex', vibeUsageReads: true, label: 'Codex' },
  gemini: { source: 'gemini-cli', vibeUsageReads: true, label: 'Gemini CLI' },
  opencode: { source: 'opencode', vibeUsageReads: true, label: 'OpenCode' },
  openchamber: { source: 'opencode', vibeUsageReads: true, label: 'OpenChamber' },
  pi: { source: 'pi-coding-agent', vibeUsageReads: true, label: 'pi' },
  kimi: { source: 'kimi-code', vibeUsageReads: true, label: 'Kimi Code' },
  qwen: { source: 'qwen-code', vibeUsageReads: true, label: 'Qwen Code' },
  minimax: { source: 'mcode', vibeUsageReads: true, label: 'MiniMax Code' },
  mimocode: { source: 'mimocode', vibeUsageReads: true, label: 'MiMoCode' },
  droid: { source: 'droid', vibeUsageReads: true, label: 'Droid' },
  cline: { source: 'cline', vibeUsageReads: true, label: 'Cline' },
  qoder: { source: 'qoder', vibeUsageReads: true, label: 'Qoder' },
  'qoder-cn': { source: 'qoder-cn', vibeUsageReads: true, label: 'Qoder CN' },
  grok: { source: 'grok', vibeUsageReads: true, label: 'Grok Build' },
  'grok-app': { source: 'grok', vibeUsageReads: true, label: 'Grok App' },
  zcode: { source: 'zcode', vibeUsageReads: true, label: 'ZCode' },
  hermes: { source: 'hermes', vibeUsageReads: true, label: 'Hermes Agent' },
  devin: { source: 'devin', vibeUsageReads: true, label: 'Devin' },
  workbuddy: { source: 'workbuddy', vibeUsageReads: true, label: 'WorkBuddy' },
  codebuddy: { source: 'codebuddy', vibeUsageReads: true, label: 'CodeBuddy Code' },
  copilot: { source: 'copilot-cli', vibeUsageReads: true, label: 'Copilot CLI' },
  cursor: { source: 'cursor', vibeUsageReads: true, label: 'Cursor CLI' },
  'cursor-local': { source: 'cursor', vibeUsageReads: true, label: 'Cursor' },
  crush: { source: 'crush', vibeUsageReads: false, label: 'Crush' },
  dsh: { source: 'dsh', vibeUsageReads: true, label: 'DeepSeek Harness' },
  omp: { source: 'omp', vibeUsageReads: true, label: 'Oh My Pi' },
  kiro: { source: 'kiro', vibeUsageReads: true, label: 'Kiro' },
  cindy: { source: 'cindy', vibeUsageReads: true, label: 'Cindy' },
  alma: { source: 'alma', vibeUsageReads: true, label: 'Alma' },
  trae: { source: 'trae-cli', vibeUsageReads: true, label: 'Trae CLI' },
  antigravity: { source: 'antigravity', vibeUsageReads: true, label: 'Antigravity' },
  agy: { source: 'antigravity', vibeUsageReads: true, label: 'Antigravity CLI' },
  amp: { source: 'amp', vibeUsageReads: true, label: 'Amp' },

  // ---- vibe-usage 未注册 source：开启后会被服务端静默丢弃 ----
  zed: { source: null, vibeUsageReads: false, label: 'Zed' },
  vscode: { source: null, vibeUsageReads: false, label: 'VS Code' },
  'vscode-insiders': { source: null, vibeUsageReads: false, label: 'VS Code Insiders' },
  vscodium: { source: null, vibeUsageReads: false, label: 'VSCodium' },
  'copilot-jetbrains': { source: null, vibeUsageReads: false, label: 'Copilot JetBrains' },
  goose: { source: null, vibeUsageReads: false, label: 'Goose' },
  raycast: { source: null, vibeUsageReads: false, label: 'Raycast' },
  t3code: { source: null, vibeUsageReads: false, label: 'T3 Code' },
  lody: { source: null, vibeUsageReads: false, label: 'Lody' },
  air: { source: null, vibeUsageReads: false, label: 'JetBrains Air' },
  aside: { source: null, vibeUsageReads: false, label: 'Aside' },
  morph: { source: null, vibeUsageReads: false, label: 'Mister Morph' },
  muse: { source: null, vibeUsageReads: false, label: 'Muse Code' },
  hanako: { source: null, vibeUsageReads: false, label: 'OpenHanako' },
  snow: { source: null, vibeUsageReads: false, label: 'Snow CLI' },
  atomcode: { source: null, vibeUsageReads: false, label: 'AtomCode' },
  pencil: { source: null, vibeUsageReads: false, label: 'Pencil' },
  openpencil: { source: null, vibeUsageReads: false, label: 'OpenPencil' },
  stepcode: { source: null, vibeUsageReads: false, label: 'StepCode' },
  mothx: { source: null, vibeUsageReads: false, label: 'MothX' },
  omo: { source: null, vibeUsageReads: false, label: 'omo' },
  'prime-agent': { source: null, vibeUsageReads: false, label: 'Prime Agent' },
  empryo: { source: null, vibeUsageReads: false, label: 'Empryo' },
  ante: { source: null, vibeUsageReads: false, label: 'Ante' },
  astrbot: { source: null, vibeUsageReads: false, label: 'AstrBot' },
  jcode: { source: null, vibeUsageReads: false, label: 'jcode' },
  reasonix: { source: null, vibeUsageReads: false, label: 'Reasonix Studio' },
  commandcode: { source: null, vibeUsageReads: false, label: 'Command Code' },
  fx: { source: null, vibeUsageReads: false, label: 'fx' },
  magpie: { source: null, vibeUsageReads: false, label: 'magpie' },
  curl: { source: null, vibeUsageReads: false, label: 'curl' },
  'pi-desktop': { source: 'pi-coding-agent', vibeUsageReads: true, label: 'PI-Desktop' },
};

/**
 * 查一个 magpie agent id 的映射。未知 id 返回 null 映射（不导入），
 * 由调用方计入 diagnostics.unknownAgent。
 *
 * @param {string} agent
 * @returns {SourceMapping|null}
 */
export function lookupAgent(agent) {
  if (typeof agent !== 'string') return null;
  const key = agent.toLowerCase().trim().replace(/@wsl:.+$/, '');
  return AGENT_SOURCES[key] ?? null;
}

/**
 * 可导入的 agent（有 source 映射），按 vibeUsageReads 分组。
 * 用于生成默认配置和文档。
 *
 * @returns {{ duplicated: string[], exclusive: string[], unmappable: string[] }}
 */
export function classifyAgents() {
  const duplicated = [];
  const exclusive = [];
  const unmappable = [];
  for (const [agent, mapping] of Object.entries(AGENT_SOURCES)) {
    if (mapping.source === null) unmappable.push(agent);
    else if (mapping.vibeUsageReads) duplicated.push(agent);
    else exclusive.push(agent);
  }
  return {
    duplicated: duplicated.sort(),
    exclusive: exclusive.sort(),
    unmappable: unmappable.sort(),
  };
}
