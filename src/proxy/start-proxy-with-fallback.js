import { releasePortOccupants } from './port-process-manager.js';

export async function startProxyWithFallback({
  proxyServer,
  configService,
  logger = console,
  releasePort = releasePortOccupants
}) {
  const requestedPort = configService.getState().proxy.port;

  try {
    const actualPort = await proxyServer.start(requestedPort);
    return {
      requestedPort,
      actualPort,
      usedFallback: false,
      error: null
    };
  } catch (error) {
    if (!isPortInUseError(error)) {
      throw error;
    }

    logger.warn?.(`Proxy port ${requestedPort} is occupied. Releasing occupying processes.`);
    let releasedProcesses = [];
    try {
      releasedProcesses = await releasePort(requestedPort);
    } catch (releaseError) {
      const finalError = new Error(
        `Proxy port ${requestedPort} could not be released: ${releaseError.message}`
      );
      finalError.cause = releaseError;
      proxyServer.setStartupError?.(finalError);
      throw finalError;
    }

    try {
      const actualPort = await proxyServer.start(requestedPort);
      logger.warn?.(`Proxy port ${requestedPort} was released and reused.`);
      return {
        requestedPort,
        actualPort,
        usedFallback: false,
        releasedProcesses,
        error
      };
    } catch (retryError) {
      if (isPortInUseError(retryError)) {
        const finalError = new Error(
          `Proxy port ${requestedPort} is still unavailable after killing occupying processes: ${retryError.message}`
        );
        finalError.cause = retryError;
        proxyServer.setStartupError?.(finalError);
        throw finalError;
      }
      throw retryError;
    }
  }
}

function isPortInUseError(error) {
  return error?.code === 'EADDRINUSE';
}
