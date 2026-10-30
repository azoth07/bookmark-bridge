import { setTimeout as delay } from 'node:timers/promises';

async function readJson(port, pathname, signal) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的服务端口。');
  const timeout = AbortSignal.timeout(3_000);
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}。`);
  return response.json();
}

/** Identify the exact protocol before attaching; never send/read a pairing token. */
export async function probeBridge(port) {
  try {
    const health = await readJson(port, '/health');
    return health?.ok === true && health.app === 'bookmark-bridge' && health.version === 2;
  } catch {
    return false;
  }
}

/** A read-only, cancellable viewer. Aborting never stops the owning service. */
export async function monitorBridge({ port, signal, onLine = console.log, interval = 1_000 }) {
  let after = 0;
  let epoch;
  let previousSummary;
  let disconnected = false;
  while (!signal?.aborted) {
    try {
      const status = await readJson(port, `/v2/status?after=${after}`, signal);
      if (!['waiting', 'syncing', 'complete', 'error'].includes(status.phase)
        || typeof status.cleaned !== 'boolean' || typeof status.epoch !== 'string'
        || !Array.isArray(status.events) || !Array.isArray(status.clients) || !Array.isArray(status.slots)) {
        throw new Error('状态接口格式无效。');
      }
      if (epoch && epoch !== status.epoch) {
        onLine('服务已重新启动，请从服务窗口获取新令牌并重新配对。');
        after = 0;
        previousSummary = undefined;
        epoch = status.epoch;
        // This response used the old session's cursor. Refetch from zero before
        // consuming it, otherwise early events in the new session are skipped.
        continue;
      }
      epoch = status.epoch;
      if (disconnected) onLine('已重新连接桥接服务。');
      disconnected = false;
      const summary = `${status.phase}/${status.cleaned}/${status.clients.length}/${status.slots.length}`;
      if (summary !== previousSummary) {
        const phaseText = { waiting: '等待另一端或一致的配对设置', syncing: '同步中，等待两端确认',
          complete: '两端全部确认完成', error: '处理失败，请查看下方状态' }[status.phase];
        onLine(`状态：${phaseText}；已注册 ${status.clients.length} 个浏览器，${status.slots.length} 个配对；整个数据目录${status.cleaned ? '已删除' : '尚未删除'}。`);
        previousSummary = summary;
      }
      for (const event of status.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= after
          || typeof event.time !== 'string' || typeof event.message !== 'string') continue;
        onLine(`[${event.time}] ${event.message}`);
        after = event.seq;
      }
    } catch {
      if (signal?.aborted) break;
      if (!disconnected) onLine('暂时无法读取桥接状态，正在等待服务恢复；本窗口不会停止原服务。');
      disconnected = true;
    }
    try { await delay(interval, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
}
