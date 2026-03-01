import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { InboxEvent, LoadedSkill } from './types.js';

const INBOX_DIR = path.join(DATA_DIR, 'events', 'inbox');
const ERRORS_DIR = path.join(DATA_DIR, 'events', 'errors');
const INBOX_POLL_MS = 2000;
const MAX_BACKOFF_MS = 300_000; // 5 minutes

export interface InboundDeps {
  resolveGroup: (channel: string, chatId: string) => string | undefined;
  storeAndNotify: (msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
    is_group?: boolean;
  }) => void;
  storeChatMetadata?: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
}

interface SkillScheduler {
  timer: ReturnType<typeof setTimeout> | null;
  process: ChildProcess | null;
  failures: number;
}

const schedulers = new Map<string, SkillScheduler>();
let inboxPollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/**
 * Start inbound schedulers for skills that have inbound config,
 * and start the inbox poller that routes events to groups.
 */
export function startInboundSchedulers(
  skills: LoadedSkill[],
  deps: InboundDeps,
): void {
  if (running) return;
  running = true;

  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(ERRORS_DIR, { recursive: true });

  for (const skill of skills) {
    if (!skill.manifest.inbound) continue;
    scheduleSkill(skill, deps);
  }

  // Start inbox poller
  pollInbox(deps);

  const skillCount = skills.filter((s) => s.manifest.inbound).length;
  if (skillCount > 0) {
    logger.info({ skillCount }, 'Inbound schedulers started');
  }
}

/**
 * Stop all inbound schedulers and the inbox poller.
 */
export function stopInboundSchedulers(): void {
  running = false;

  for (const [name, scheduler] of schedulers) {
    if (scheduler.timer) clearTimeout(scheduler.timer);
    if (scheduler.process) {
      scheduler.process.kill('SIGTERM');
      logger.debug({ skill: name }, 'Killed inbound process');
    }
  }
  schedulers.clear();

  if (inboxPollTimer) {
    clearTimeout(inboxPollTimer);
    inboxPollTimer = null;
  }
}

function scheduleSkill(skill: LoadedSkill, deps: InboundDeps): void {
  const name = skill.manifest.name;
  const inbound = skill.manifest.inbound!;
  const isPersistent = inbound.persistent === true;
  const baseInterval = inbound.intervalMs ?? 5000;

  const scheduler: SkillScheduler = {
    timer: null,
    process: null,
    failures: 0,
  };
  schedulers.set(name, scheduler);

  const run = () => {
    if (!running) return;

    const entrypoint = path.resolve(skill.dir, inbound.entrypoint);
    logger.debug(
      { skill: name, entrypoint, persistent: isPersistent },
      'Spawning inbound entrypoint',
    );

    const outboxDir = path.join(DATA_DIR, 'events', 'outbox', name);
    fs.mkdirSync(outboxDir, { recursive: true });

    const env: Record<string, string | undefined> = {
      ...process.env,
      NANOCLAW_INBOX_DIR: INBOX_DIR,
      NANOCLAW_OUTBOX_DIR: outboxDir,
      NANOCLAW_STORE_DIR: STORE_DIR,
      NANOCLAW_DATA_DIR: DATA_DIR,
      NANOCLAW_SKILL_NAME: name,
      NANOCLAW_SKILL_DIR: skill.dir,
      ...(skill.inboundEnv || {}),
    };

    const proc = spawn('node', [entrypoint], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    scheduler.process = proc;

    proc.stdout?.on('data', (data) => {
      logger.debug({ skill: name }, data.toString().trim());
    });

    proc.stderr?.on('data', (data) => {
      logger.warn({ skill: name }, `stderr: ${data.toString().trim()}`);
    });

    proc.on('close', (code) => {
      scheduler.process = null;

      if (code === 0) {
        scheduler.failures = 0;
        if (isPersistent) {
          logger.info(
            { skill: name },
            'Persistent service exited cleanly, restarting',
          );
        } else {
          logger.debug({ skill: name }, 'Inbound entrypoint completed');
        }
      } else {
        scheduler.failures++;
        logger.warn(
          {
            skill: name,
            code,
            failures: scheduler.failures,
            persistent: isPersistent,
          },
          isPersistent
            ? 'Persistent service crashed'
            : 'Inbound entrypoint failed',
        );
      }

      if (!running) return;

      // Schedule restart with backoff on failure
      const delay =
        scheduler.failures > 0
          ? Math.min(
              baseInterval * Math.pow(2, scheduler.failures - 1),
              MAX_BACKOFF_MS,
            )
          : isPersistent
            ? 5000 // persistent services restart after 5s on clean exit
            : baseInterval;

      scheduler.timer = setTimeout(run, delay);
    });

    proc.on('error', (err) => {
      scheduler.process = null;
      scheduler.failures++;
      logger.error(
        { skill: name, err, failures: scheduler.failures },
        'Failed to spawn inbound entrypoint',
      );

      if (!running) return;

      const delay = Math.min(
        baseInterval * Math.pow(2, scheduler.failures - 1),
        MAX_BACKOFF_MS,
      );
      scheduler.timer = setTimeout(run, delay);
    });
  };

  // Start first run immediately
  run();
}

function pollInbox(deps: InboundDeps): void {
  if (!running) return;

  try {
    const files = fs
      .readdirSync(INBOX_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(INBOX_DIR, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const event: InboxEvent = JSON.parse(raw);

        if (!event.channel || !event.chatId) {
          logger.warn({ file }, 'Malformed inbox event, moving to errors');
          fs.renameSync(filePath, path.join(ERRORS_DIR, file));
          continue;
        }

        // Handle chat metadata events (group discovery, name updates)
        if (event.type === 'chat_metadata') {
          if (deps.storeChatMetadata) {
            deps.storeChatMetadata(
              event.chatId,
              event.timestamp,
              event.metadata?.name as string | undefined,
              event.channel,
              event.metadata?.isGroup as boolean | undefined,
            );
          }
          fs.unlinkSync(filePath);
          logger.debug(
            { channel: event.channel, chatId: event.chatId },
            'Chat metadata event processed',
          );
          continue;
        }

        // Message events require content
        if (!event.content) {
          logger.warn(
            { file },
            'Malformed inbox event (no content), moving to errors',
          );
          fs.renameSync(filePath, path.join(ERRORS_DIR, file));
          continue;
        }

        const jid = deps.resolveGroup(event.channel, event.chatId);
        if (!jid) {
          logger.debug(
            { channel: event.channel, chatId: event.chatId },
            'No group mapping for inbox event, skipping',
          );
          fs.unlinkSync(filePath);
          continue;
        }

        const messageId =
          event.messageId ||
          `inbox-${event.channel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        deps.storeAndNotify({
          id: messageId,
          chat_jid: jid,
          sender: event.sender,
          sender_name: event.senderName,
          content: event.content,
          timestamp: event.timestamp,
          is_from_me: false,
          is_bot_message: event.metadata?.isBotMessage === true,
          is_group: event.metadata?.isGroup === true ? true : undefined,
        });

        fs.unlinkSync(filePath);
        logger.debug(
          { channel: event.channel, chatId: event.chatId, jid },
          'Inbox event routed',
        );
      } catch (err) {
        logger.error({ file, err }, 'Error processing inbox event');
        try {
          fs.renameSync(filePath, path.join(ERRORS_DIR, file));
        } catch {
          /* best effort */
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error reading inbox directory');
  }

  inboxPollTimer = setTimeout(() => pollInbox(deps), INBOX_POLL_MS);
}
