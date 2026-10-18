// 配置页面的数据与文案，不碰 DOM —— 测试直接加载它。
//
// 这个文件同时被两种环境加载：
//   - 浏览器：<script src="view.js"> 普通脚本，不能有 export
//   - Node 测试：import 它拿到具名导出
// 所以写成 UMD 风格：挂到 globalThis，同时在有 module 时导出。

(function (root) {
  // 分三类呈现给用户：
  //   duplicate  能导，但 vibe-usage 自己也会读，同时开启会重复计数
  //   exclusive  能导，vibe-usage 不读，可安全开启
  //   blocked    vibe-usage 未注册 source，开启也导不进去
  const GROUPS = {
    duplicate: {
      title: '会与 vibe-usage 重复',
      hint: 'vibe-usage 自己会读这些工具的日志。同时开启会让面板数字翻倍。',
      tone: 'warn',
    },
    exclusive: {
      title: '可安全开启',
      hint: 'vibe-usage 不读这些工具，开启不会重复。',
      tone: 'ok',
    },
    blocked: {
      title: '暂时导不进去',
      hint: 'vibecafe 服务端还没注册这些 source，开启后数据会被静默丢弃。',
      tone: 'bad',
    },
  };

  /**
   * 把配置和清单整理成渲染用的结构。
   *
   * @param {Record<string, {enabled: boolean}>} sources 当前配置
   * @param {Record<string, {source: string|null, vibeUsageReads: boolean, label: string}>} catalog 完整清单
   */
  function buildView(sources, catalog) {
    const groups = { duplicate: [], exclusive: [], blocked: [] };

    for (const [agent, meta] of Object.entries(catalog)) {
      const state = sources[agent] ?? { enabled: false };
      const item = {
        agent,
        label: meta.label || agent,
        source: meta.source,
        enabled: state.enabled === true,
      };
      if (meta.source === null) groups.blocked.push(item);
      else if (meta.vibeUsageReads) groups.duplicate.push(item);
      else groups.exclusive.push(item);
    }

    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => a.agent.localeCompare(b.agent));
    }

    const enabledCount =
      groups.duplicate.filter((x) => x.enabled).length +
      groups.exclusive.filter((x) => x.enabled).length;

    return { groups, enabledCount };
  }

  /** 从渲染状态还原成要写回 magpie 的 options。 */
  function toOptions(view, { includeOthers = false } = {}) {
    const sources = {};
    for (const key of Object.keys(view.groups)) {
      for (const item of view.groups[key]) {
        if (item.enabled) sources[item.agent] = { enabled: true };
      }
    }
    return { sources, includeOthers };
  }

  /**
   * 一句话概括当前状态，显示在页面顶部。
   * 文案刻意直白：用户不该靠读代码理解自己在开什么。
   */
  function summarize(view, { signedIn = false, includeOthers = false } = {}) {
    const { groups } = view;
    // 每次现算，不用 buildView 时的快照 —— 用户勾选后摘要要立刻反映。
    const dupOn = groups.duplicate.filter((x) => x.enabled).length;
    const exclusiveOn = groups.exclusive.filter((x) => x.enabled).length;
    const blockedOn = groups.blocked.filter((x) => x.enabled).length;
    const enabledCount = dupOn + exclusiveOn;

    const parts = [];
    if (!signedIn) parts.push('尚未登录，不会上传任何数据。');
    if (enabledCount === 0) parts.push('未开启任何工具，不会上传任何数据。');
    else parts.push(`已开启 ${enabledCount} 个工具。`);

    if (dupOn > 0) parts.push(`其中 ${dupOn} 个会与 vibe-usage 重复计数。`);
    if (blockedOn > 0) parts.push(`${blockedOn} 个服务端未注册，开启无效。`);
    if (includeOthers) parts.push('已包含其他机器的数据。');
    return parts.join(' ');
  }

  root.VibecafeView = { GROUPS, buildView, toOptions, summarize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
