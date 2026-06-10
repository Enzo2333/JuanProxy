import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_FILE_NAME = 'runtime-errors.jsonl';
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_STRING_LENGTH = 4000;
const DEFAULT_MAX_ARRAY_ITEMS = 50;
const DEFAULT_MAX_OBJECT_KEYS = 80;
const REDACTED = '[REDACTED]';
const TRUNCATED = '...[truncated]';

export class RuntimeLogger {
  constructor({
    directory,
    filePath,
    fileName = DEFAULT_FILE_NAME,
    now = () => new Date(),
    appVersion = null,
    makeDirectory = mkdir,
    append = appendFile,
    console: consoleLike = globalThis.console
  } = {}) {
    if (!filePath && !directory) {
      throw new Error('directory or filePath is required');
    }

    this.filePath = filePath ?? join(directory, fileName);
    this.now = now;
    this.appVersion = appVersion;
    this.makeDirectory = makeDirectory;
    this.append = append;
    this.console = consoleLike;
    this.writeQueue = Promise.resolve();
  }

  error(source, error, context = {}) {
    return this.write({
      level: 'error',
      source,
      error,
      context
    });
  }

  warn(source, message, context = {}) {
    return this.write({
      level: 'warn',
      source,
      message,
      context
    });
  }

  info(source, message, context = {}) {
    return this.write({
      level: 'info',
      source,
      message,
      context
    });
  }

  createConsoleBridge(source) {
    return {
      error: (...args) => this.logConsoleArgs('error', source, args),
      warn: (...args) => this.logConsoleArgs('warn', source, args),
      info: (...args) => this.logConsoleArgs('info', source, args),
      log: (...args) => this.logConsoleArgs('info', source, args)
    };
  }

  logConsoleArgs(level, source, args) {
    const consoleMethod = level === 'warn' ? 'warn' : level === 'info' ? 'info' : 'error';
    this.console?.[consoleMethod]?.(...args);

    const { message, error, context } = parseConsoleArgs(args);
    const write = this.write({
      level,
      source,
      message,
      error,
      context
    });
    write.catch?.(() => {});
    return write;
  }

  async write({ level = 'error', source = 'runtime', message, error, context = {} } = {}) {
    const entry = this.createEntry({
      level,
      source,
      message,
      error,
      context
    });
    const line = `${JSON.stringify(entry)}\n`;

    const run = this.writeQueue.then(async () => {
      await this.makeDirectory(dirname(this.filePath), { recursive: true });
      await this.append(this.filePath, line, 'utf8');
      return {
        ok: true,
        filePath: this.filePath
      };
    });
    this.writeQueue = run.catch(() => {});

    try {
      return await run;
    } catch (writeError) {
      this.console?.error?.('Failed to write runtime log:', writeError);
      return {
        ok: false,
        filePath: this.filePath,
        error: serializeErrorForLog(writeError)
      };
    }
  }

  async flush() {
    await this.writeQueue.catch(() => {});
  }

  createEntry({ level, source, message, error, context }) {
    const serializedError = error === undefined || error === null
      ? null
      : serializeErrorForLog(error);
    const sanitizedMessage = sanitizeLogValue(
      message ?? serializedError?.message ?? String(error ?? 'Runtime log entry')
    );
    const entry = {
      timestamp: this.now().toISOString(),
      level: String(level ?? 'error'),
      source: String(source ?? 'runtime'),
      message: sanitizedMessage,
      error: serializedError,
      context: sanitizeLogValue(context ?? {})
    };

    if (this.appVersion) {
      entry.appVersion = String(this.appVersion);
    }

    return stripUndefined(entry);
  }
}

export function createRuntimeLogger({ userDataPath, appVersion, now } = {}) {
  if (!userDataPath) {
    throw new Error('userDataPath is required');
  }

  return new RuntimeLogger({
    directory: join(userDataPath, 'logs'),
    fileName: DEFAULT_FILE_NAME,
    appVersion,
    now
  });
}

export function sanitizeLogValue(value, options = {}) {
  return sanitizeValue(value, {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    maxArrayItems: options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
    maxObjectKeys: options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
    seen: new WeakSet()
  });
}

export function serializeErrorForLog(error) {
  if (error instanceof Error || isErrorLike(error)) {
    const details = {
      name: error.name || error.constructor?.name || 'Error',
      message: error.message ?? String(error),
      stack: error.stack,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      address: error.address,
      port: error.port,
      statusCode: error.statusCode ?? error.status
    };

    for (const key of Object.keys(error)) {
      if (key === 'cause' || Object.hasOwn(details, key)) {
        continue;
      }
      details[key] = error[key];
    }

    if (error.cause) {
      details.cause = serializeErrorForLog(error.cause);
    }

    return stripUndefined(sanitizeLogValue(details));
  }

  return {
    name: typeof error,
    message: sanitizeLogValue(String(error ?? 'Unknown error'))
  };
}

function sanitizeValue(value, options, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return boundText(redactText(value), options.maxStringLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${value.name}` : ''}]`;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
  }
  if (value instanceof URL) {
    return redactText(value.href);
  }
  if (value instanceof Error) {
    return serializeErrorForLog(value);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`;
  }

  if (typeof value !== 'object') {
    return String(value);
  }
  if (options.seen.has(value)) {
    return '[Circular]';
  }
  if (depth >= options.maxDepth) {
    return '[Object]';
  }

  options.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, options.maxArrayItems)
        .map((item) => sanitizeValue(item, options, depth + 1));
      if (value.length > options.maxArrayItems) {
        items.push(`[${value.length - options.maxArrayItems} more items]`);
      }
      return items;
    }

    const output = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, options.maxObjectKeys)) {
      output[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item, options, depth + 1);
    }
    if (entries.length > options.maxObjectKeys) {
      output.__truncatedKeys = entries.length - options.maxObjectKeys;
    }
    return output;
  } finally {
    options.seen.delete(value);
  }
}

function parseConsoleArgs(args) {
  let message = '';
  let error = null;
  const contextValues = [];

  for (const arg of args) {
    if ((arg instanceof Error || isErrorLike(arg)) && !error) {
      error = arg;
      if (arg.message) {
        message = `${message} ${arg.message}`.trim();
      }
      continue;
    }

    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
      message = `${message} ${String(arg)}`.trim();
      continue;
    }

    contextValues.push(arg);
  }

  return {
    message: message || error?.message || 'Runtime log entry',
    error,
    context: contextValues.length <= 1 ? contextValues[0] ?? {} : { values: contextValues }
  };
}

function isSensitiveKey(key) {
  return /authorization|password|passwd|secret|token|cookie|session|credential|api[-_]?key|apikey/i
    .test(String(key ?? ''));
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=-]+/gi, 'Basic [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g, 'sk-[REDACTED]')
    .replace(
      /([?&](?:api[-_]?key|apikey|key|token|password|secret|access[-_]?token|refresh[-_]?token)=)[^&#\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /\b(api[-_]?key|apikey|token|password|secret|access[-_]?token|refresh[-_]?token)=([^\s&]+)/gi,
      '$1=[REDACTED]'
    );
}

function boundText(value, maxLength) {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}${TRUNCATED}`
    : value;
}

function isErrorLike(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (typeof value.message === 'string' || typeof value.stack === 'string')
  );
}

function stripUndefined(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}
