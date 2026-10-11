export function resolvePendingOrderTimeoutMs(env = process.env) {
  const minutes = Number(env.PENDING_ORDER_TIMEOUT_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 30 * 60 * 1000;
  }
  return Math.floor(minutes * 60 * 1000);
}

export function createPendingOrderSweeper({
  repository,
  olderThanMs,
  intervalMs = 60 * 1000,
  logger = console,
} = {}) {
  if (!repository || typeof repository.cancelExpiredPendingOrders !== "function") {
    throw new Error("repository.cancelExpiredPendingOrders is required");
  }

  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cancelled = await repository.cancelExpiredPendingOrders({ olderThanMs });
      if (cancelled.length > 0) {
        logger.info?.(
          `[commerce-api] cancelled ${cancelled.length} expired pending_payment order(s)`,
        );
      }
      return cancelled;
    } catch (error) {
      logger.warn?.(
        `[commerce-api] pending order sweeper failed: ${error.message || error}`,
      );
      return [];
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      // Fire once shortly after boot, then on interval.
      timer = setInterval(() => {
        tick();
      }, intervalMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      setTimeout(() => tick(), 1500).unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
