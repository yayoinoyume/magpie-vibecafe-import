// 上报节奏：每 30 分钟一次，与 vibe-usage 守护进程对齐。
//
// 为什么不是每天一次：
//   vibe-usage 的桶是半小时粒度，每 30 分钟上传能让数据接近实时，
//   而且增量上传天然幂等 —— 重复跑只会跳过没变的桶。

export const INTERVAL_MS = 30 * 60 * 1000;

// 启动后先等一会儿再跑第一次，避免和 magpie 宿主启动抢占资源。
export const INITIAL_DELAY_MS = 60 * 1000;

/**
 * 启动定时器。
 *
 * @param {() => Promise<any>} tick 每次执行的任务
 * @param {{onError?: (err: Error) => void, intervalMs?: number, initialDelayMs?: number}} opts
 * @returns {() => void} 停止函数
 */
export function startScheduler(tick, { onError, intervalMs = INTERVAL_MS, initialDelayMs = INITIAL_DELAY_MS } = {}) {
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void run(), initialDelayMs);
  initial.unref?.();

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(timer);
  };
}
