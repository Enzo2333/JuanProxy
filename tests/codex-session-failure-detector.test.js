import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  findRecentJuanProxyFailures,
  inspectCodexRollout,
  isRetryableCodexTaskError,
  JUANPROXY_NO_SITE_CODE,
  JUANPROXY_NO_SITE_MESSAGE
} from '../src/codex/codex-session-failure-detector.js';

const THREAD_ID = '019fb606-ce21-7931-8bb4-4d43e00bfa66';

function event(payload, timestamp = '2026-07-31T02:40:00.000Z') {
  return JSON.stringify({ timestamp, type: 'event_msg', payload });
}

function rootMeta(id = THREAD_ID) {
  return JSON.stringify({
    timestamp: '2026-07-31T02:30:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      cwd: 'E:\\Commercial_Project\\JuanProxy',
      thread_source: 'app'
    }
  });
}

async function writeRollout(dir, lines, id = THREAD_ID) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-31T10-35-27-${id}.jsonl`);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

test('detects the latest root task completion caused by JuanProxy no-site failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-failure-'));
  try {
    const path = await writeRollout(dir, [
      rootMeta(),
      event({ type: 'task_started', turn_id: 'turn-1' }),
      event({
        type: 'task_complete',
        turn_id: 'turn-1',
        error: { message: `unexpected status 503: ${JUANPROXY_NO_SITE_MESSAGE}` }
      })
    ]);

    assert.deepEqual(await inspectCodexRollout(path), {
      threadId: THREAD_ID,
      failedTurnId: 'turn-1',
      rolloutPath: path,
      cwd: 'E:\\Commercial_Project\\JuanProxy',
      failedAt: '2026-07-31T02:40:00.000Z'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects the stable JuanProxy no-site error code without relying on message wording', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-error-code-'));
  try {
    const path = await writeRollout(dir, [
      rootMeta(),
      event({
        type: 'task_complete',
        turn_id: 'turn-code',
        error: { message: `upstream error code: ${JUANPROXY_NO_SITE_CODE}` }
      })
    ]);

    assert.equal((await inspectCodexRollout(path))?.failedTurnId, 'turn-code');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects model-capacity and incomplete-stream failures for Codex task retry', async () => {
  const retryableMessages = [
    'Selected model is at capacity. Please try a different model.',
    'stream disconnected before completion: stream closed before response.completed'
  ];

  for (const [index, message] of retryableMessages.entries()) {
    const dir = await mkdtemp(join(tmpdir(), `juanproxy-codex-retryable-${index}-`));
    try {
      const path = await writeRollout(dir, [
        rootMeta(),
        event({
          type: 'task_complete',
          turn_id: `turn-retryable-${index}`,
          error: { message }
        })
      ]);

      assert.equal(isRetryableCodexTaskError(message), true);
      assert.equal((await inspectCodexRollout(path))?.failedTurnId, `turn-retryable-${index}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  assert.equal(isRetryableCodexTaskError('invalid request payload'), false);
});

test('ignores matching text in tool output and a later successful task completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-false-positive-'));
  try {
    const toolOnly = await writeRollout(join(dir, 'tool'), [
      rootMeta(),
      JSON.stringify({
        timestamp: '2026-07-31T02:40:00.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', output: JUANPROXY_NO_SITE_MESSAGE }
      })
    ]);
    const recovered = await writeRollout(join(dir, 'recovered'), [
      rootMeta(),
      event({
        type: 'task_complete',
        turn_id: 'turn-1',
        error: { message: JUANPROXY_NO_SITE_MESSAGE }
      }),
      event({ type: 'task_started', turn_id: 'turn-2' }, '2026-07-31T02:41:00.000Z'),
      event({ type: 'task_complete', turn_id: 'turn-2', error: null }, '2026-07-31T02:42:00.000Z')
    ]);

    assert.equal(await inspectCodexRollout(toolOnly), null);
    assert.equal(await inspectCodexRollout(recovered), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not resume a thread with a newer in-progress turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-newer-turn-'));
  try {
    const path = await writeRollout(dir, [
      rootMeta(),
      event({
        type: 'task_complete',
        turn_id: 'turn-1',
        error: { message: JUANPROXY_NO_SITE_MESSAGE }
      }),
      event({ type: 'task_started', turn_id: 'turn-2' }, '2026-07-31T02:41:00.000Z')
    ]);

    assert.equal(await inspectCodexRollout(path), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('skips subagent rollout failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-subagent-'));
  try {
    const childId = '019fb3a0-e622-7c32-95bf-c54249e6c251';
    const path = await writeRollout(dir, [
      JSON.stringify({
        timestamp: '2026-07-31T02:30:00.000Z',
        type: 'session_meta',
        payload: {
          session_id: THREAD_ID,
          id: childId,
          parent_thread_id: THREAD_ID,
          cwd: 'E:\\Commercial_Project\\JuanProxy',
          thread_source: 'subagent'
        }
      }),
      event({
        type: 'task_complete',
        turn_id: 'child-turn',
        error: { message: JUANPROXY_NO_SITE_MESSAGE }
      })
    ], childId);

    assert.equal(await inspectCodexRollout(path), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finds only recent unique root failures under the sessions tree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-recent-'));
  try {
    const sessionsDir = join(dir, 'sessions');
    const rolloutDir = join(sessionsDir, '2026', '07', '31');
    const path = await writeRollout(rolloutDir, [
      rootMeta(),
      event({
        type: 'task_complete',
        turn_id: 'turn-latest',
        error: { message: JUANPROXY_NO_SITE_MESSAGE }
      })
    ]);

    const failures = await findRecentJuanProxyFailures({
      sessionsDir,
      sinceMs: Date.now() - 60_000
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0].threadId, THREAD_ID);
    assert.equal(failures[0].rolloutPath, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finds every recent successful root turn completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-completions-'));
  try {
    const path = await writeRollout(dir, [
      rootMeta(),
      event({
        type: 'task_complete',
        turn_id: 'turn-old',
        completed_at: 1785456000,
        duration_ms: 1000
      }, '2026-07-31T00:00:00.000Z'),
      event({
        type: 'task_complete',
        turn_id: 'turn-1',
        started_at: 1785462600,
        completed_at: 1785462630,
        duration_ms: 30000
      }, '2026-07-31T01:50:30.000Z'),
      event({
        type: 'task_complete',
        turn_id: 'turn-failed',
        error: { code: 'upstream_failed' }
      }, '2026-07-31T01:51:00.000Z'),
      event({
        type: 'task_complete',
        turn_id: 'turn-2',
        started_at: 1785462700,
        completed_at: 1785462720,
        duration_ms: 20000
      }, '2026-07-31T01:52:00.000Z')
    ]);
    const detector = await import('../src/codex/codex-session-failure-detector.js');

    assert.equal(typeof detector.inspectCodexRolloutCompletions, 'function');
    assert.deepEqual(
      await detector.inspectCodexRolloutCompletions(path, {
        sinceMs: Date.parse('2026-07-31T01:50:00.000Z')
      }),
      [
        {
          threadId: THREAD_ID,
          turnId: 'turn-1',
          rolloutPath: path,
          cwd: 'E:\\Commercial_Project\\JuanProxy',
          startedAt: '2026-07-31T01:50:00.000Z',
          completedAt: '2026-07-31T01:50:30.000Z',
          durationMs: 30000
        },
        {
          threadId: THREAD_ID,
          turnId: 'turn-2',
          rolloutPath: path,
          cwd: 'E:\\Commercial_Project\\JuanProxy',
          startedAt: '2026-07-31T01:51:40.000Z',
          completedAt: '2026-07-31T01:52:00.000Z',
          durationMs: 20000
        }
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns recent events when an open rollout has a stale modification time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-events-'));
  try {
    const detector = await import('../src/codex/codex-session-failure-detector.js');
    const path = await writeRollout(dir, [
      rootMeta(),
      event({
        type: 'thread_goal_updated',
        threadId: THREAD_ID,
        goal: {
          threadId: THREAD_ID,
          objective: 'must not leave the detector',
          status: 'active',
          createdAt: 1785462600,
          updatedAt: 1785462600
        }
      }, '2026-07-31T01:50:00.000Z'),
      event({
        type: 'task_complete',
        turn_id: 'goal-turn',
        completed_at: 1785462630,
        duration_ms: 30000
      }, '2026-07-31T01:50:30.000Z'),
      event({
        type: 'thread_goal_updated',
        threadId: THREAD_ID,
        goal: {
          threadId: THREAD_ID,
          objective: 'must not leave the detector',
          status: 'paused',
          createdAt: 1785462600,
          updatedAt: 1785462631
        }
      }, '2026-07-31T01:50:31.000Z')
    ]);
    await utimes(path, new Date('2026-07-31T01:48:00.000Z'), new Date('2026-07-31T01:48:00.000Z'));

    assert.equal(typeof detector.findRecentCodexEvents, 'function');
    assert.deepEqual(await detector.findRecentCodexEvents({
      sessionsDir: dir,
      eventSinceMs: Date.parse('2026-07-31T01:49:00.000Z'),
      modifiedSinceMs: Date.parse('2026-07-31T01:54:00.000Z')
    }), [
      {
        type: 'goal',
        key: `${THREAD_ID}:1785462600:1785462600:active`,
        threadId: THREAD_ID,
        rolloutPath: path,
        cwd: 'E:\\Commercial_Project\\JuanProxy',
        status: 'active',
        createdAt: '2026-07-31T01:50:00.000Z',
        updatedAt: '2026-07-31T01:50:00.000Z'
      },
      {
        type: 'completion',
        key: `${THREAD_ID}:goal-turn`,
        threadId: THREAD_ID,
        turnId: 'goal-turn',
        rolloutPath: path,
        cwd: 'E:\\Commercial_Project\\JuanProxy',
        startedAt: null,
        completedAt: '2026-07-31T01:50:30.000Z',
        durationMs: 30000
      },
      {
        type: 'goal',
        key: `${THREAD_ID}:1785462600:1785462631:paused`,
        threadId: THREAD_ID,
        rolloutPath: path,
        cwd: 'E:\\Commercial_Project\\JuanProxy',
        status: 'paused',
        createdAt: '2026-07-31T01:50:00.000Z',
        updatedAt: '2026-07-31T01:50:31.000Z'
      }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
