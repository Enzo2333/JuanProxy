import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { recoverAvailableSites } from './recover-sites.js';
import { SiteAvailabilityWaiter } from './site-availability-waiter.js';
import { testSiteAvailability } from './site-tester.js';
import { syncLikelySiteSyncSites } from './site-sync-scheduler.js';
import { classifyUpstreamHttpError } from './upstream-error-classification.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
]);

const ERROR_SNIPPET_LIMIT = 1000;
const DEFAULT_MAX_REPLAYABLE_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_ERROR_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_BUFFERED_RETRYABLE_ERROR_BODY_BYTES = 1024 * 1024;
const INCOMPLETE_RESPONSES_STREAM_ERROR =
  'stream disconnected before completion: stream closed before response.completed';
const RESPONSES_COMPLETED_EVENT = 'response.completed';
const ROUTE_TRACE_TEXT_LIMIT = 240;

export class OpenApiProxyServer extends EventEmitter {
  constructor(options = {}) {
    const {
      configService,
      timeoutMs = 120000,
      siteTester = testSiteAvailability,
      siteSyncPreheater = syncLikelySiteSyncSites,
      logger = console,
      maxReplayableRequestBodyBytes,
      availabilityWaitTimeoutMs,
      availabilityPollIntervalMs,
      maxPendingRecoveryRequests,
      maxBufferedErrorBodyBytes = DEFAULT_MAX_BUFFERED_ERROR_BODY_BYTES,
      maxBufferedRetryableErrorBodyBytes = DEFAULT_MAX_BUFFERED_RETRYABLE_ERROR_BODY_BYTES
    } = options;
    super();
    if (!configService) {
      throw new Error('configService is required');
    }
    const hasMaxReplayableRequestBodyBytes = Object.hasOwn(
      options,
      'maxReplayableRequestBodyBytes'
    );
    this.configService = configService;
    this.timeoutMs = timeoutMs;
    this.siteTester = siteTester;
    this.siteSyncPreheater = siteSyncPreheater;
    this.logger = logger;
    this.useConfiguredMaxReplayableRequestBodyBytes = !hasMaxReplayableRequestBodyBytes;
    this.maxReplayableRequestBodyBytes = normalizeByteLimit(
      maxReplayableRequestBodyBytes,
      DEFAULT_MAX_REPLAYABLE_REQUEST_BODY_BYTES
    );
    this.maxBufferedErrorBodyBytes = maxBufferedErrorBodyBytes;
    this.maxBufferedRetryableErrorBodyBytes = maxBufferedRetryableErrorBodyBytes;
    this.availabilityWaiter = new SiteAvailabilityWaiter({
      configService,
      waitTimeoutMs: availabilityWaitTimeoutMs,
      pollIntervalMs: availabilityPollIntervalMs,
      maxPendingRequests: maxPendingRecoveryRequests
    });
    this.server = null;
    this.host = null;
    this.port = null;
    this.error = null;
    this.lifecycleQueue = Promise.resolve();
    this.siteSyncPreheatRunning = false;
  }

  async start(port = this.configService.getProxyPort()) {
    return this.enqueueLifecycle(() => this.startNow(port));
  }

  async startNow(port) {
    const host = this.configService.getProxyListenHost();
    if (this.server) {
      if ((port === 0 || this.port === port) && this.host === host) {
        return this.port;
      }
      await this.stopNow();
    }

    const nextServer = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.sendJsonError(res, 500, 'Proxy internal error', error);
      });
    });
    this.server = nextServer;

    try {
      await new Promise((resolve, reject) => {
        nextServer.once('error', reject);
        nextServer.listen(port, host, () => {
          nextServer.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      this.host = null;
      this.port = null;
      this.error = error;
      nextServer.close(() => {});
      this.emit('start-error', error);
      throw error;
    }

    this.host = host;
    this.port = nextServer.address().port;
    this.error = null;
    this.emit('started', this.port);
    return this.port;
  }

  async stop() {
    return this.enqueueLifecycle(() => this.stopNow());
  }

  async stopNow() {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.availabilityWaiter.cancelAll('stopped');
    this.server = null;
    this.host = null;
    this.port = null;
    this.error = null;

    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    this.emit('stopped');
  }

  enqueueLifecycle(operation) {
    const run = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = run.catch(() => {});
    return run;
  }

  getStatus() {
    return {
      running: Boolean(this.server),
      host: this.host,
      port: this.port,
      error: this.error ? formatStatusError(this.error) : null,
      pendingRecoveryRequests: this.availabilityWaiter.getStatus().pendingRequests
    };
  }

  setStartupError(error) {
    this.error = error;
    this.emit('start-error', error);
  }

  async handle(req, res) {
    if (req.method === 'GET' && req.url === '/__proxy/health') {
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (
      !this.configService.hasLocalApiKey() ||
      !this.configService.verifyLocalApiKey(readBearerToken(req.headers.authorization))
    ) {
      this.sendJson(res, 401, {
        error: {
          code: 'juanproxy_invalid_api_key',
          message: 'Invalid local API key'
        }
      }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    const requestBody = await prepareRequestBody(req, this.getMaxReplayableRequestBodyBytes());
    const requestDiagnostics = createRequestDiagnostics(req, requestBody);
    const routeTrace = createRouteTrace(requestDiagnostics, {
      initialActiveSiteId: this.configService.getActiveSiteId(),
      startedAt: new Date()
    });
    const attemptedSiteIds = new Set();
    let lastFailure = null;
    let requestLocalSelection = false;
    let availabilityWaitDeadlineMs = null;
    let routeTraceEmitted = false;
    const emitRouteTrace = (updates = {}) => {
      if (routeTraceEmitted) {
        return;
      }
      routeTraceEmitted = true;
      this.emit('route-trace', completeRouteTrace(routeTrace, {
        ...updates,
        finalActiveSiteId: this.configService.getActiveSiteId(),
        completedAt: new Date()
      }));
    };

    try {
      while (!res.headersSent) {
        const site = await this.resolveActiveSite({
          excludeSiteIds: attemptedSiteIds,
          allowRecovery: attemptedSiteIds.size === 0,
          persistSelection: !requestLocalSelection
        });
        if (!site) {
          const waitResult = await this.waitForSiteAvailability({
            requestBody,
            res,
            deadlineMs: availabilityWaitDeadlineMs
          });
          availabilityWaitDeadlineMs ??= waitResult.deadlineMs ?? null;
          if (waitResult.reason === 'retry') {
            attemptedSiteIds.clear();
            lastFailure = null;
            continue;
          }
          if (waitResult.reason === 'aborted' || waitResult.reason === 'stopped') {
            emitRouteTrace({
              outcome: 'aborted',
              finalSiteId: lastFailure?.siteId ?? null,
              finalStatusCode: getRouteTraceStatusCode(lastFailure)
            });
            if (waitResult.reason === 'stopped' && !res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (waitResult.enabled) {
            this.sendNoAvailableSite(res, {
              req,
              requestBody,
              reason: waitResult.reason
            });
            emitRouteTrace({
              outcome: 'no-site',
              finalSiteId: null,
              finalStatusCode: 503
            });
            return;
          }
          if (lastFailure) {
            this.notifyCodexRetryForFailure({
              req,
              requestBody,
              failure: lastFailure
            });
            this.sendForwardFailure(res, lastFailure);
            emitRouteTrace({
              outcome: getRouteTraceOutcome(lastFailure),
              finalSiteId: lastFailure.siteId ?? null,
              finalStatusCode: getRouteTraceStatusCode(lastFailure)
            });
          } else {
            this.sendJson(res, 503, {
              error: {
                message: 'No active API site configuration is available'
              }
            });
            emitRouteTrace({
              outcome: 'no-site',
              finalSiteId: null,
              finalStatusCode: 503
            });
          }
          return;
        }

        attemptedSiteIds.add(site.id);
        const target = composeTargetUrl(site.baseUrl, req.url);
        const result = await this.forwardRequest({
          req,
          res,
          site,
          target,
          requestBody,
          requestDiagnostics
        });
        updateRouteTraceRequest(routeTrace, result.request);
        routeTrace.attempts.push(createRouteTraceAttempt(site, result));
        if (result.ok) {
          emitRouteTrace({
            outcome: getRouteTraceOutcome(result),
            finalSiteId: site.id,
            finalStatusCode: getRouteTraceStatusCode(result)
          });
          return;
        }

        lastFailure = result;
        if (!requestBody.replayable || result.retryable === false) {
          this.notifyCodexRetryForFailure({
            req,
            requestBody,
            failure: lastFailure
          });
          this.sendForwardFailure(res, lastFailure);
          emitRouteTrace({
            outcome: getRouteTraceOutcome(lastFailure),
            finalSiteId: site.id,
            finalStatusCode: getRouteTraceStatusCode(lastFailure)
          });
          return;
        }
        if (result.requestLocalRetry) {
          requestLocalSelection = true;
        }
      }

      emitRouteTrace({
        outcome: 'aborted',
        finalSiteId: lastFailure?.siteId ?? null,
        finalStatusCode: getRouteTraceStatusCode(lastFailure)
      });
    } catch (error) {
      emitRouteTrace({
        outcome: 'proxy-error',
        finalSiteId: lastFailure?.siteId ?? null,
        finalStatusCode: getRouteTraceStatusCode(lastFailure)
      });
      throw error;
    }
  }

  async waitForSiteAvailability({ requestBody, res, deadlineMs }) {
    const enabled = Boolean(this.configService.getState().proxy?.codexRecoveryEnabled);
    if (!enabled) {
      return { enabled: false, reason: 'disabled', deadlineMs: null };
    }
    if (!requestBody.replayable) {
      return { enabled: true, reason: 'not-replayable', deadlineMs: null };
    }

    const resolvedDeadlineMs = deadlineMs ?? this.availabilityWaiter.getDeadlineMs();
    const result = await this.availabilityWaiter.wait({
      abortEmitter: res,
      deadlineMs: resolvedDeadlineMs
    });
    return {
      enabled: result.reason !== 'disabled',
      reason: result.reason,
      deadlineMs: resolvedDeadlineMs
    };
  }

  sendNoAvailableSite(res, { req, requestBody, reason }) {
    this.sendJson(res, 503, {
      error: {
        code: 'juanproxy_no_available_site',
        message: 'No active API site configuration is available'
      }
    });
    this.emit('availability-exhausted', {
      occurredAt: new Date().toISOString(),
      method: req.method ?? null,
      path: req.url ?? null,
      replayable: Boolean(requestBody.replayable),
      reason
    });
  }

  notifyCodexRetryForFailure({ req, requestBody, failure }) {
    if (!failure?.classification?.codexTaskRetry) {
      return;
    }

    this.emitCodexRetryNeeded({
      req,
      requestBody,
      siteId: failure.siteId,
      reason: 'model-capacity'
    });
  }

  emitCodexRetryNeeded({ req, requestBody, siteId, reason }) {
    this.emit('codex-retry-needed', {
      occurredAt: new Date().toISOString(),
      method: req.method ?? null,
      path: parseRequestUrl(req.url).pathname,
      replayable: Boolean(requestBody?.replayable),
      siteId: siteId ?? null,
      reason
    });
  }

  async resolveActiveSite(options = {}) {
    this.scheduleSiteSyncPreheat(options);

    const site = await this.configService.selectSiteForRequest(new Date(), options);
    if (site) {
      return site;
    }

    if (this.hasTemporarilyUnavailableEnabledSites()) {
      return null;
    }

    if (options.allowRecovery === false) {
      return null;
    }

    const recovered = await this.recoverAvailableSites();
    if (recovered.enabledSites.length === 0) {
      return null;
    }

    return this.configService.selectSiteForRequest(new Date(), options);
  }

  scheduleSiteSyncPreheat(options = {}) {
    if (this.siteSyncPreheatRunning || !this.siteSyncPreheater) {
      return;
    }

    this.siteSyncPreheatRunning = true;
    Promise.resolve()
      .then(() => this.siteSyncPreheater({
        configService: this.configService,
        now: new Date(),
        excludeSiteIds: options.excludeSiteIds
      }))
      .then((result) => {
        if (result?.syncedSites?.length > 0 || result?.failedSites?.length > 0) {
          this.emit('site-sync-preheated', result);
        }
      })
      .catch((error) => {
        this.logger.error?.('Remote site sync preheat failed:', error);
        this.emit('site-sync-preheat-error', error);
      })
      .finally(() => {
        this.siteSyncPreheatRunning = false;
      });
  }

  async recoverAvailableSites() {
    const result = await recoverAvailableSites({
      configService: this.configService,
      testSite: (site, options) => this.siteTester(site, options)
    });
    if (result.enabledSites.length > 0) {
      this.emit('sites-recovered', result);
    }
    return result;
  }

  async forwardRequest({ req, res, site, target, requestBody, requestDiagnostics }) {
    const transport = target.protocol === 'https:' ? https : http;
    const { requestBody: outboundRequestBody, modelRewrite } = prepareForwardRequestBody({
      req,
      site,
      requestBody,
      globalModelMapping: this.configService.getModelMapping?.()
    });
    const completedRequestDiagnostics = finalizeRequestDiagnostics(
      requestDiagnostics,
      modelRewrite
    );
    const headers = buildForwardHeaders(req.headers, site.apiKey, {
      contentLength: shouldSendReplayableBody(req, outboundRequestBody)
        ? outboundRequestBody.body.length
        : undefined
    });
    const timeoutMs = getRequestTimeoutMs(this.getConfiguredTimeoutMs());
    const options = {
      method: req.method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs
    };

    return new Promise((resolve) => {
      let settled = false;
      let responseStarted = false;
      let upstreamReq = null;
      let clientDisconnected = false;
      const settle = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const cancelUpstream = () => {
        if (settled || !upstreamReq || upstreamReq.destroyed) {
          return;
        }
        clientDisconnected = true;
        upstreamReq.destroy(new Error('Client disconnected before upstream response completed'));
        settle({
          ok: true,
          aborted: true,
          kind: 'aborted',
          siteId: site.id,
          request: completedRequestDiagnostics
        });
      };

      req.on('aborted', cancelUpstream);
      res.on('close', () => {
        if (!res.writableEnded) {
          cancelUpstream();
        }
      });

      upstreamReq = transport.request(options, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;
        const responseHeaders = filterResponseHeaders(upstreamRes.headers);

        if (statusCode >= 400) {
          const contentLength = parseContentLength(upstreamRes.headers['content-length']);
          const shouldDrainForRetry = outboundRequestBody.replayable && statusCode === 429;
          const errorResponseBufferLimit = getErrorResponseBufferLimit(
            statusCode,
            this.maxBufferedErrorBodyBytes,
            this.maxBufferedRetryableErrorBodyBytes
          );
          const streamDirectly =
            !outboundRequestBody.replayable ||
            (
              !shouldDrainForRetry &&
              contentLength !== null &&
              contentLength > errorResponseBufferLimit
            );
          const chunks = [];
          let errorSnippet = '';
          let bufferedBytes = 0;
          let streamingToClient = streamDirectly;
          let dropBufferedBody = false;

          if (streamingToClient) {
            responseStarted = true;
            res.writeHead(statusCode, responseHeaders);
          }

          upstreamRes.on('data', (chunk) => {
            bufferedBytes += chunk.length;
            if (errorSnippet.length < ERROR_SNIPPET_LIMIT) {
              errorSnippet += chunk.toString('utf8', 0, ERROR_SNIPPET_LIMIT - errorSnippet.length);
            }

            if (
              !streamingToClient &&
              bufferedBytes > errorResponseBufferLimit
            ) {
              if (shouldDrainForRetry) {
                dropBufferedBody = true;
                chunks.length = 0;
                return;
              }

              streamingToClient = true;
              responseStarted = true;
              res.writeHead(statusCode, responseHeaders);
              for (const buffered of chunks) {
                res.write(buffered);
              }
              chunks.length = 0;
            }

            if (streamingToClient) {
              res.write(chunk);
            } else if (!dropBufferedBody) {
              chunks.push(chunk);
            }
          });

          upstreamRes.on('end', () => {
            const responseBody = Buffer.concat(chunks);
            const classification = classifyUpstreamHttpError({
              statusCode,
              bodyText: responseBody.length > 0 ? responseBody.toString('utf8') : errorSnippet
            });

            this.recordCompletedRequest({
              site,
              statusCode,
              errorSnippet,
              affectsSiteHealth: classification.affectsSiteHealth
            })
              .then(() => {
                this.emit('request-complete', {
                  siteId: site.id,
                  statusCode,
                  request: completedRequestDiagnostics
                });
              })
              .catch((error) => {
                this.emit('request-error', { siteId: site.id, error });
              })
              .finally(() => {
                if (streamingToClient) {
                  if (!res.writableEnded) {
                    res.end();
                  }
                  settle({
                    ok: true,
                    kind: 'upstream-response',
                    siteId: site.id,
                    statusCode,
                    retryable: false,
                    requestLocalRetry: false,
                    classification,
                    request: completedRequestDiagnostics
                  });
                  return;
                }

                settle({
                  ok: false,
                  kind: 'upstream-response',
                  siteId: site.id,
                  statusCode,
                  headers: responseHeaders,
                  body: responseBody,
                  retryable: classification.retryable,
                  requestLocalRetry: Boolean(classification.requestLocalRetry),
                  classification,
                  request: completedRequestDiagnostics
                });
              });
          });

          upstreamRes.on('error', (error) => {
            if (clientDisconnected) {
              settle({
                ok: true,
                aborted: true,
                kind: 'aborted',
                siteId: site.id,
                request: completedRequestDiagnostics
              });
              return;
            }
            this.recordFailedRequest(site, { message: error.message })
              .catch((recordError) => {
                this.emit('request-error', { siteId: site.id, error: recordError });
              })
              .finally(() => {
                this.emit('request-error', { siteId: site.id, error });
                settle({
                  ok: false,
                  kind: 'network-error',
                  siteId: site.id,
                  error,
                  request: completedRequestDiagnostics
                });
              });
          });

          return;
        }

        responseStarted = true;
        const completionTracker = createResponsesStreamCompletionTracker(req, upstreamRes);

        res.writeHead(statusCode, responseHeaders);

        upstreamRes.on('data', (chunk) => {
          completionTracker?.observe(chunk);
        });
        upstreamRes.pipe(res);

        upstreamRes.on('end', () => {
          const incompleteStreamError = completionTracker?.getIncompleteError();
          if (incompleteStreamError) {
            this.emitCodexRetryNeeded({
              req,
              requestBody: outboundRequestBody,
              siteId: site.id,
              reason: 'incomplete-responses-stream'
            });
          }
          const recordResult = incompleteStreamError
            ? this.recordFailedRequest(site, incompleteStreamError)
            : this.recordCompletedRequest({ site, statusCode, errorSnippet: '' });

          recordResult
            .then(() => {
              this.emit('request-complete', {
                siteId: site.id,
                statusCode,
                request: completedRequestDiagnostics
              });
            })
            .catch((error) => {
              this.emit('request-error', { siteId: site.id, error });
            })
            .finally(() => {
              settle({
                ok: true,
                kind: incompleteStreamError ? 'network-error' : 'upstream-response',
                siteId: site.id,
                statusCode,
                error: incompleteStreamError ?? null,
                request: completedRequestDiagnostics
              });
            });
        });

        upstreamRes.on('error', (error) => {
          if (clientDisconnected) {
            settle({
              ok: true,
              aborted: true,
              kind: 'aborted',
              siteId: site.id,
              request: completedRequestDiagnostics
            });
            return;
          }
          this.recordFailedRequest(site, { message: error.message })
            .catch((recordError) => {
              this.emit('request-error', { siteId: site.id, error: recordError });
            })
            .finally(() => {
              if (!res.writableEnded) {
                res.end();
              }
              this.emit('request-error', { siteId: site.id, error });
              settle({
                ok: true,
                kind: 'network-error',
                siteId: site.id,
                statusCode,
                error,
                request: completedRequestDiagnostics
              });
            });
        });
      });

      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error(formatUpstreamTimeoutMessage(timeoutMs)));
      });

      upstreamReq.on('error', (error) => {
        if (clientDisconnected) {
          settle({
            ok: true,
            aborted: true,
            kind: 'aborted',
            siteId: site.id,
            request: completedRequestDiagnostics
          });
          return;
        }
        this.recordFailedRequest(site, { message: error.message })
          .catch((recordError) => {
            this.emit('request-error', { siteId: site.id, error: recordError });
          })
          .finally(() => {
            if (!responseStarted && !res.headersSent) {
              settle({
                ok: false,
                kind: 'network-error',
                siteId: site.id,
                error,
                request: completedRequestDiagnostics
              });
            } else if (!res.writableEnded) {
              res.end();
              settle({
                ok: true,
                kind: 'network-error',
                siteId: site.id,
                error,
                request: completedRequestDiagnostics
              });
            } else {
              settle({
                ok: true,
                kind: 'network-error',
                siteId: site.id,
                error,
                request: completedRequestDiagnostics
              });
            }

            this.emit('request-error', { siteId: site.id, error });
          });
      });

      if (req.method === 'GET' || req.method === 'HEAD') {
        upstreamReq.end();
      } else if (outboundRequestBody.replayable) {
        upstreamReq.end(outboundRequestBody.body);
      } else if (Buffer.isBuffer(outboundRequestBody.prefix) && outboundRequestBody.prefix.length > 0) {
        upstreamReq.write(outboundRequestBody.prefix);
        req.pipe(upstreamReq);
        req.resume();
      } else {
        req.pipe(upstreamReq);
      }
    });
  }

  getConfiguredTimeoutMs() {
    return this.configService.getProxyTimeoutMs() ?? this.timeoutMs;
  }

  getMaxReplayableRequestBodyBytes() {
    if (!this.useConfiguredMaxReplayableRequestBodyBytes) {
      return this.maxReplayableRequestBodyBytes;
    }
    return normalizeByteLimit(
      this.configService.getMaxReplayableRequestBodyBytes?.(),
      this.maxReplayableRequestBodyBytes
    );
  }

  hasTemporarilyUnavailableEnabledSites() {
    return this.configService.hasEnabledSites();
  }

  async recordCompletedRequest({ site, statusCode, errorSnippet, affectsSiteHealth = true }) {
    if (statusCode >= 400) {
      const details = {
        statusCode,
        message: `Upstream returned HTTP ${statusCode}`,
        detail: trimSnippet(errorSnippet)
      };
      if (affectsSiteHealth) {
        await this.recordFailedRequest(site, details);
      } else {
        await this.recordSiteRequestFailureIfPresent(site.id, details);
      }
      return;
    }

    await this.recordSiteSuccessIfPresent(site.id, { statusCode });
  }

  async recordFailedRequest(site, details) {
    await this.recordSiteFailureIfPresent(site.id, details);
  }

  async recordSiteSuccessIfPresent(siteId, details) {
    try {
      return await this.configService.recordSiteSuccess(siteId, details);
    } catch (error) {
      if (isSiteNotFoundError(error, siteId)) {
        return null;
      }
      throw error;
    }
  }

  async recordSiteFailureIfPresent(siteId, details) {
    try {
      return await this.configService.recordSiteFailure(siteId, details);
    } catch (error) {
      if (isSiteNotFoundError(error, siteId)) {
        return null;
      }
      throw error;
    }
  }

  async recordSiteRequestFailureIfPresent(siteId, details) {
    try {
      return await this.configService.recordSiteRequestFailure(siteId, details);
    } catch (error) {
      if (isSiteNotFoundError(error, siteId)) {
        return null;
      }
      throw error;
    }
  }

  sendJsonError(res, statusCode, message, error) {
    this.sendJson(res, statusCode, {
      error: {
        message,
        detail: error?.message ?? String(error)
      }
    });
  }

  sendJson(res, statusCode, body, headers = {}) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...headers
    });
    res.end(payload);
  }

  sendForwardFailure(res, failure) {
    if (failure.kind === 'upstream-response') {
      res.writeHead(failure.statusCode, failure.headers);
      res.end(failure.body);
      return;
    }

    this.sendJson(res, 502, {
      error: {
        message: 'Proxy could not reach upstream API site',
        detail: failure.error?.message ?? String(failure.error)
      }
    });
  }
}

function readBearerToken(authorization) {
  const match = /^Bearer[ \t]+([^\s,]+)[ \t]*$/i.exec(String(authorization ?? ''));
  return match?.[1] ?? '';
}

export function composeTargetUrl(baseUrl, requestUrl) {
  const target = new URL(baseUrl);
  const incoming = new URL(requestUrl, 'http://127.0.0.1');
  incoming.searchParams.delete('api_key');
  let basePath = stripTrailingSlash(target.pathname);
  let incomingPath = incoming.pathname;

  if (basePath && isOpenAiV1Path(incomingPath)) {
    incomingPath = incomingPath.slice('/v1'.length) || '/';
  }
  if (basePath.endsWith('/v1') && isCodexBackendPath(incomingPath)) {
    basePath = basePath.slice(0, -'/v1'.length) || '/';
  }

  target.pathname = joinUrlPaths(basePath, incomingPath);
  target.search = incoming.search;
  return target;
}

function buildForwardHeaders(inputHeaders, apiKey, options = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(inputHeaders)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key' ||
      lower === 'cookie' ||
      (options.contentLength !== undefined && lower === 'content-length')
    ) {
      continue;
    }
    headers[name] = value;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  if (options.contentLength !== undefined) {
    headers['Content-Length'] = String(options.contentLength);
  }
  return headers;
}

function filterResponseHeaders(inputHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(inputHeaders)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

function joinUrlPaths(basePath, incomingPath) {
  const left = stripTrailingSlash(basePath);
  const right = incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`;
  if (!left || left === '/') {
    return right;
  }
  if (right === '/') {
    return left;
  }
  return `${left}${right}`;
}

function stripTrailingSlash(value) {
  if (!value || value === '/') {
    return '';
  }
  return value.replace(/\/+$/, '');
}

function isOpenAiV1Path(pathname) {
  return pathname === '/v1' || pathname.startsWith('/v1/');
}

function isCodexBackendPath(pathname) {
  return pathname === '/backend-api' || pathname.startsWith('/backend-api/');
}

export function getRequestTimeoutMs(defaultTimeoutMs) {
  return defaultTimeoutMs;
}

export function formatUpstreamTimeoutMessage(timeoutMs) {
  return `Upstream timed out after ${Math.max(timeoutMs, 50)}ms`;
}

function isSiteNotFoundError(error, siteId) {
  return error?.message === `Site not found: ${siteId}`;
}

function trimSnippet(value) {
  return value.length > ERROR_SNIPPET_LIMIT ? value.slice(0, ERROR_SNIPPET_LIMIT) : value;
}

function getErrorResponseBufferLimit(statusCode, defaultLimit, retryableLimit) {
  const baseLimit = normalizeByteLimit(defaultLimit, DEFAULT_MAX_BUFFERED_ERROR_BODY_BYTES);
  if (Number(statusCode) !== 429) {
    return baseLimit;
  }

  return Math.max(
    baseLimit,
    normalizeByteLimit(retryableLimit, DEFAULT_MAX_BUFFERED_RETRYABLE_ERROR_BODY_BYTES)
  );
}

function normalizeByteLimit(value, fallback) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
}

function formatStatusError(error) {
  return {
    message: error?.message ?? String(error),
    code: error?.code ?? null
  };
}

async function prepareRequestBody(req, maxReplayableBytes) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return {
      replayable: true,
      body: Buffer.alloc(0)
    };
  }

  const contentLength = parseContentLength(req.headers['content-length']);
  if (contentLength === null) {
    if (isJsonContentType(req.headers['content-type'])) {
      return readUnknownLengthJsonRequestBody(req, maxReplayableBytes);
    }
    return {
      replayable: false,
      body: null,
      prefix: null
    };
  }

  if (contentLength > maxReplayableBytes) {
    return {
      replayable: false,
      body: null,
      prefix: null
    };
  }

  return {
    replayable: true,
    body: await readRequestBody(req, maxReplayableBytes)
  };
}

function prepareForwardRequestBody({ req, site, requestBody, globalModelMapping }) {
  if (!requestBody.replayable || req.method === 'GET' || req.method === 'HEAD') {
    return {
      requestBody,
      modelRewrite: null
    };
  }

  const rewrite = rewriteRequestModel({
    body: requestBody.body,
    contentType: req.headers['content-type'],
    siteModelMapping: site.modelMapping,
    globalModelMapping
  });
  const rewrittenBody = rewrite.body;

  if (rewrittenBody === requestBody.body) {
    return {
      requestBody,
      modelRewrite: rewrite.modelRewrite
    };
  }

  return {
    requestBody: {
      ...requestBody,
      body: rewrittenBody
    },
    modelRewrite: rewrite.modelRewrite
  };
}

function rewriteRequestModel({ body, contentType, siteModelMapping, globalModelMapping }) {
  const unchanged = (modelRewrite = null) => ({ body, modelRewrite });
  if (!Buffer.isBuffer(body) || body.length === 0 || !isJsonContentType(contentType)) {
    return unchanged();
  }

  let payload = null;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return unchanged();
  }

  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return unchanged();
  }
  if (typeof payload.model !== 'string') {
    return unchanged();
  }

  const mappedModel = resolveMappedModel(payload.model, siteModelMapping, globalModelMapping);
  if (!mappedModel || mappedModel === payload.model) {
    return unchanged({
      originalModel: payload.model,
      forwardedModel: payload.model,
      modelMapped: false
    });
  }

  return {
    body: Buffer.from(JSON.stringify({
      ...payload,
      model: mappedModel
    })),
    modelRewrite: {
      originalModel: payload.model,
      forwardedModel: mappedModel,
      modelMapped: true
    }
  };
}

function resolveMappedModel(model, siteModelMapping, globalModelMapping) {
  return (
    findModelMappingTarget(siteModelMapping, model) ??
    findModelMappingTarget(globalModelMapping, model)
  );
}

function findModelMappingTarget(modelMapping, model) {
  if (!modelMapping?.enabled || !Array.isArray(modelMapping.mappings)) {
    return null;
  }

  return modelMapping.mappings.find((entry) => entry?.from === model)?.to ?? null;
}

function isJsonContentType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return false;
  }

  const type = String(raw).split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

function createRequestDiagnostics(req, requestBody) {
  const parsedUrl = parseRequestUrl(req.url);
  return {
    id: randomUUID(),
    method: req.method,
    path: parsedUrl.pathname,
    queryKeys: Array.from(parsedUrl.searchParams.keys()).sort(),
    contentType: normalizeHeaderValue(req.headers['content-type']),
    replayable: Boolean(requestBody.replayable),
    originalModel: null,
    forwardedModel: null,
    modelMapped: false
  };
}

function finalizeRequestDiagnostics(requestDiagnostics, modelRewrite) {
  if (!modelRewrite) {
    return requestDiagnostics;
  }

  return {
    ...requestDiagnostics,
    originalModel: modelRewrite.originalModel ?? null,
    forwardedModel: modelRewrite.forwardedModel ?? null,
    modelMapped: Boolean(modelRewrite.modelMapped)
  };
}

function createRouteTrace(requestDiagnostics, { initialActiveSiteId, startedAt }) {
  const startedDate = startedAt instanceof Date ? startedAt : new Date(startedAt);
  return {
    id: requestDiagnostics.id,
    startedAt: startedDate.toISOString(),
    completedAt: null,
    durationMs: 0,
    method: requestDiagnostics.method,
    path: requestDiagnostics.path,
    queryKeys: [...(requestDiagnostics.queryKeys ?? [])],
    contentType: requestDiagnostics.contentType,
    replayable: Boolean(requestDiagnostics.replayable),
    originalModel: requestDiagnostics.originalModel ?? null,
    forwardedModel: requestDiagnostics.forwardedModel ?? null,
    modelMapped: Boolean(requestDiagnostics.modelMapped),
    initialActiveSiteId: initialActiveSiteId ?? null,
    finalActiveSiteId: null,
    finalSiteId: null,
    finalStatusCode: null,
    outcome: 'pending',
    requestLocalFailover: false,
    globalSelectionPreserved: null,
    attempts: []
  };
}

function updateRouteTraceRequest(routeTrace, requestDiagnostics) {
  if (!routeTrace || !requestDiagnostics) {
    return;
  }

  routeTrace.method = requestDiagnostics.method ?? routeTrace.method;
  routeTrace.path = requestDiagnostics.path ?? routeTrace.path;
  routeTrace.queryKeys = Array.isArray(requestDiagnostics.queryKeys)
    ? [...requestDiagnostics.queryKeys]
    : routeTrace.queryKeys;
  routeTrace.contentType = requestDiagnostics.contentType ?? null;
  routeTrace.replayable = Boolean(requestDiagnostics.replayable);
  routeTrace.originalModel = requestDiagnostics.originalModel ?? null;
  routeTrace.forwardedModel = requestDiagnostics.forwardedModel ?? null;
  routeTrace.modelMapped = Boolean(requestDiagnostics.modelMapped);
}

function createRouteTraceAttempt(site, result = {}) {
  const statusCode = getRouteTraceStatusCode(result);
  const attempt = {
    siteId: result.siteId ?? site?.id ?? null,
    siteName: sanitizeRouteTraceText(site?.name ?? null),
    ok: isRouteTraceAttemptSuccess(result),
    kind: normalizeRouteTraceAttemptKind(result, statusCode),
    classification: sanitizeRouteTraceClassification(result.classification)
  };

  if (statusCode !== null) {
    attempt.statusCode = statusCode;
  }

  const errorMessage = result.error?.message ?? (
    result.error ? String(result.error) : null
  );
  if (errorMessage) {
    attempt.errorMessage = sanitizeRouteTraceText(errorMessage);
  }

  return attempt;
}

function completeRouteTrace(routeTrace, updates = {}) {
  const completedDate = updates.completedAt instanceof Date
    ? updates.completedAt
    : new Date(updates.completedAt ?? Date.now());
  const startedMs = new Date(routeTrace.startedAt).getTime();
  const completedMs = completedDate.getTime();
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(completedMs)
    ? Math.max(0, completedMs - startedMs)
    : 0;

  routeTrace.completedAt = completedDate.toISOString();
  routeTrace.durationMs = durationMs;
  routeTrace.finalActiveSiteId = updates.finalActiveSiteId ?? null;
  routeTrace.finalSiteId = updates.finalSiteId ?? null;
  routeTrace.finalStatusCode = normalizeRouteTraceStatusCode(updates.finalStatusCode);
  routeTrace.outcome = updates.outcome ?? 'unknown';
  routeTrace.requestLocalFailover = routeTrace.attempts.length > 1 &&
    routeTrace.attempts.some((attempt) => attempt.classification?.requestLocalRetry === true);
  routeTrace.globalSelectionPreserved =
    routeTrace.finalActiveSiteId === routeTrace.initialActiveSiteId;

  return {
    ...routeTrace,
    queryKeys: [...routeTrace.queryKeys],
    attempts: routeTrace.attempts.map((attempt) => ({ ...attempt }))
  };
}

function getRouteTraceOutcome(result = {}) {
  if (result.aborted) {
    return 'aborted';
  }
  if (result.kind === 'network-error') {
    return 'network-error';
  }

  const statusCode = getRouteTraceStatusCode(result);
  if (statusCode !== null && statusCode >= 400) {
    return 'upstream-error';
  }
  if (result.ok) {
    return 'success';
  }
  if (result.kind === 'upstream-response') {
    return 'upstream-error';
  }
  return 'network-error';
}

function getRouteTraceStatusCode(result = {}) {
  return normalizeRouteTraceStatusCode(result?.statusCode);
}

function normalizeRouteTraceStatusCode(value) {
  const statusCode = Number(value);
  if (!Number.isInteger(statusCode) || statusCode <= 0) {
    return null;
  }
  return statusCode;
}

function isRouteTraceAttemptSuccess(result = {}) {
  const statusCode = getRouteTraceStatusCode(result);
  return Boolean(result.ok) &&
    !result.aborted &&
    result.kind !== 'network-error' &&
    (statusCode === null || statusCode < 400);
}

function normalizeRouteTraceAttemptKind(result = {}, statusCode = null) {
  if (result.aborted) {
    return 'aborted';
  }
  if (result.kind) {
    return String(result.kind);
  }
  return statusCode === null ? 'network-error' : 'upstream-response';
}

function sanitizeRouteTraceClassification(classification) {
  if (!classification) {
    return null;
  }

  return {
    retryable: Boolean(classification.retryable),
    requestLocalRetry: Boolean(classification.requestLocalRetry),
    affectsSiteHealth: Boolean(classification.affectsSiteHealth),
    reason: sanitizeRouteTraceText(classification.reason ?? '')
  };
}

function sanitizeRouteTraceText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const redacted = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]+/gi, '[REDACTED]')
    .replace(/\b(api[_-]?key|token|password|secret)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/\b(api[_-]?key|token|password|secret):([^\s]+)/gi, '$1:[REDACTED]');

  if (redacted.length <= ROUTE_TRACE_TEXT_LIMIT) {
    return redacted;
  }
  return `${redacted.slice(0, ROUTE_TRACE_TEXT_LIMIT)}...[truncated]`;
}

function parseRequestUrl(value) {
  try {
    return new URL(value || '/', 'http://127.0.0.1');
  } catch {
    return new URL('/', 'http://127.0.0.1');
  }
}

function normalizeHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return null;
  }
  return String(raw).split(';')[0].trim().toLowerCase() || null;
}

function createResponsesStreamCompletionTracker(req, upstreamRes) {
  if (!isResponsesStreamRequest(req, upstreamRes)) {
    return null;
  }

  let completed = false;
  let tail = '';
  return {
    observe(chunk) {
      if (completed) {
        return;
      }

      tail = `${tail}${chunk.toString('utf8')}`;
      if (tail.includes(RESPONSES_COMPLETED_EVENT)) {
        completed = true;
        tail = '';
        return;
      }

      tail = tail.slice(-RESPONSES_COMPLETED_EVENT.length);
    },
    getIncompleteError() {
      if (completed) {
        return null;
      }
      return {
        statusCode: null,
        message: INCOMPLETE_RESPONSES_STREAM_ERROR,
        detail: 'Upstream text/event-stream ended before a response.completed event.',
        affectsSiteHealth: true
      };
    }
  };
}

function isResponsesStreamRequest(req, upstreamRes) {
  return (
    isResponsesPath(req.url) &&
    normalizeHeaderValue(upstreamRes.headers['content-type']) === 'text/event-stream'
  );
}

function isResponsesPath(value) {
  return parseRequestUrl(value).pathname.endsWith('/responses');
}

function shouldSendReplayableBody(req, requestBody) {
  return req.method !== 'GET' && req.method !== 'HEAD' && requestBody.replayable;
}

function readRequestBody(req, maxBytes) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return Promise.resolve(Buffer.alloc(0));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body exceeds replay buffer limit of ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function readUnknownLengthJsonRequestBody(req, maxBytes) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return Promise.resolve({
      replayable: true,
      body: Buffer.alloc(0)
    });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk) => {
      totalBytes += chunk.length;
      chunks.push(chunk);
      if (totalBytes <= maxBytes) {
        return;
      }

      req.pause();
      settle({
        replayable: false,
        body: null,
        prefix: Buffer.concat(chunks)
      });
    };
    const onEnd = () => {
      settle({
        replayable: true,
        body: Buffer.concat(chunks)
      });
    };
    const onError = (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseContentLength(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
