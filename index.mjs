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
      async config(config) {
        // 注册成一个 provider，这样 magpie 的插件列表里能看到登录入口。
        // 本插件不提供模型，models 为空。
        config.provider ??= {};
        config.provider[AUTH_PROVIDER] ??= { name: 'Vibecafe Import', models: {} };

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
