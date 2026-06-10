import { EventEmitter } from 'node:events';

import { releasePortOccupants } from './port-process-manager.js';

const DEFAULT_INTERVAL_MS = 60_000;

export class PortOccupancyGuard extends EventEmitter {
  constructor({
    configService,
    proxyServer,
    releasePort = releasePortOccupants,
    intervalMs = DEFAULT_INTERVAL_MS,
    runtimePolling = false,
    logger = console
  }) {
    super();
    if (!configService) {
      throw new Error('configService is required');
    }
    if (!proxyServer) {
      throw new Error('proxyServer is required');
    }
    this.configService = configService;
    this.proxyServer = proxyServer;
    this.releasePort = releasePort;
    this.intervalMs = intervalMs;
    this.runtimePolling = runtimePolling;
    this.logger = logger;
    this.timer = null;
    this.checking = false;
  }

  start() {
    if (!this.runtimePolling) {
      return;
    }
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.checkNow().catch((error) => {
        this.logger.error?.('Port occupancy guard failed:', error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async checkNow() {
    if (this.checking) {
      return null;
    }
    this.checking = true;

    try {
      const port = this.configService.getState().proxy.port;
      const result = await this.releasePort(port);
      if (result.length > 0) {
        this.logger.warn?.(`Port ${port} occupants released during runtime.`);
        this.emit('released', { port, processes: result });
      }
      return result;
    } catch (error) {
      this.proxyServer.setStartupError?.(error);
      this.emit('guard-error', error);
      throw error;
    } finally {
      this.checking = false;
    }
  }
}
