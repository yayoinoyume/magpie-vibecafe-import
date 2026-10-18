import { AUTH_PROVIDER, configuration, enabledAgents, ineffectiveAgents } from './lib/config.mjs';
import { startScheduler } from './lib/scheduler.mjs';
import { run } from './lib/worker.mjs';

// magpie 插件入口。
//
// 导出形状必须是 { id, server }，否则 magpie 会把每个导出函数都当插件调用。
// 参考 magpie 插件文档「导出形式」一节。

export default {
  id: 'magpie-vibecafe-import',

  async server(input, options = {}) {
    if (input?.project?.id !== 'magpie') {
      throw new Error('本插件需要读取 magpie 的 usage.jsonl。在 magpie 之外请用独立 CLI。');
    }

    const settings = configuration(options, input.directory);

    let stopScheduler;
    let lastLog;

    const log = async (message, level = 'info') => {
      if (message === lastLog) return;
      lastLog = message;
      try {
        await input.client.app.log({ body: { service: 'vibecafe-import', level, message } });
      } catch {
        // 日志里可能含请求数据，失败时只写 stderr，不回显内容。
        console.error('[vibecafe-import] ' + message);
      }
    };

    return {
      async config() {
        // 刻意不注册 config.provider。
        //
        // 本插件不提供任何模型，注册成供应商会让供应商列表里多一个
        // 没有模型的假条目，用户还会误以为要从那里选模型。
        //
        // 登录入口不依赖 config.provider：magpie 的 providers() 遍历的是
        // 有 auth hook 的插件（host.js 的 auths()），只要下面还返回 auth
        // 就能登录，密钥照样存进 plugin-auth.json。

        const enabled = enabledAgents(settings.sources);
        const ineffective = ineffectiveAgents(settings.sources);

        if (enabled.length === 0) {
          await log(
            '未开启任何 agent，不会上传任何数据。' +
            '在插件选项的 sources 里把想导入的工具设为 true。',
            'info',
          );
        } else {
          await log(`已开启：${enabled.join(', ')}（每 30 分钟增量上传）`, 'info');
        }

        // 开了但导不进去的 agent，必须明确告警 —— 否则用户会以为在正常工作。
        for (const agent of ineffective) {
          await log(
            `${agent}: 已开启，但 vibe-usage 未注册该 source，数据会被服务端静默丢弃。`,
            'warn',
          );
        }

        // 重复计数的风险，每次启动都提一次。
        for (const agent of enabled) {
          if (settings.sources[agent]?.note?.includes('重复')) {
            await log(`${agent}: ${settings.sources[agent].note}`, 'warn');
          }
        }

        if (settings.autoUpload === false) {
          await log('自动上传已被配置关闭（autoUpload: false）。', 'info');
          return;
        }

        stopScheduler ??= startScheduler(
          async () => {
            const result = await run(settings);
            // 只在有事发生、出问题、或有警告时记日志，避免每 30 分钟刷一条。
            if (
              result.status !== 'unchanged'
              || result.warnings?.length
              || result.status === 'auth-blocked'
              || result.status === 'failed'
            ) {
              const level = result.status === 'failed' || result.status === 'auth-blocked' ? 'error' : 'info';
              await log(JSON.stringify(result), level);
            }
          },
          { onError: (error) => void log(error.message, 'error') },
        );
      },

      // 登录入口：magpie 靠这个 hook 知道本插件有一个叫 vibecafe-import
      // 的账号，密钥存进 plugin-auth.json（权限 600）。
      // 它不要求插件同时注册 config.provider。
      auth: {
        provider: AUTH_PROVIDER,
        methods: [{
          type: 'api',
          label: 'Vibecafe API key — 创建地址 https://vibecafe.ai/usage/setup',
          placeholder: 'vbu_...',
        }],
      },
    };
  },
};
