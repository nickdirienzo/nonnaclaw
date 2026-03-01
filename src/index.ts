import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  setLoadedSkills,
  writeGroupsSnapshot,
  writeStateSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllKvStateForGroup,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChannelMapping,
  initDatabase,
  setRegisteredGroup,
  setSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { writeOutboxEvent } from './outbox.js';
import { loadSkills, resolveSkillForJid } from './skill-registry.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { callBridgeTool, startMcpBridges, stopMcpBridges } from './mcp-bridge.js';
import { LoadedSkill, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

const queue = new GroupQueue();
let skills: LoadedSkill[] = [];

/**
 * In-memory message buffer. Accumulates messages per group between dispatch
 * cycles. Drained by processGroupMessages when a container spins up.
 */
const pendingMessages = new Map<string, NewMessage[]>();

/**
 * Send a message to a JID via the MCP bridge or skill outbox.
 * MCP skills with send_message are called directly via the bridge.
 * Legacy handler-based skills use the file-based outbox.
 */
async function sendToJid(jid: string, text: string): Promise<void> {
  const skillName = resolveSkillForJid(skills, jid);
  if (!skillName) {
    logger.warn({ jid }, 'No skill for JID, cannot send message');
    return;
  }

  // Try MCP bridge first (for MCP-based skills like WhatsApp)
  const skill = skills.find((s) => s.manifest.name === skillName);
  if (skill?.manifest.mcp && skill.manifest.scopeTemplate?.send_message) {
    const sent = await callBridgeTool(skillName, 'send_message', {
      recipient: jid,
      message: text,
    });
    if (sent) return;
    logger.warn({ jid, skillName }, 'MCP bridge send failed, trying outbox fallback');
  }

  // Fallback: file-based outbox for handler-based skills
  writeOutboxEvent(skillName, {
    type: 'message',
    jid,
    text,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Check if we can send to a JID (via skill).
 */
function canSendToJid(jid: string): boolean {
  return !!resolveSkillForJid(skills, jid);
}

function loadState(): void {
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns registered groups (used by IPC refresh_groups handler).
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  return Object.entries(registeredGroups).map(([jid, group]) => ({
    jid,
    name: group.name,
    lastActivity: group.added_at,
    isRegistered: true,
  }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 * Drains the in-memory pendingMessages buffer.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  if (!canSendToJid(chatJid)) {
    logger.warn({ chatJid }, 'No channel or skill owns JID, skipping messages');
    return true;
  }

  // Drain buffered messages
  const buffered = pendingMessages.get(chatJid);
  if (!buffered || buffered.length === 0) return true;
  const messages = buffered.splice(0);

  const prompt = formatMessages(messages);

  logger.info(
    { group: group.name, messageCount: messages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await sendToJid(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't re-buffer —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping re-buffer to prevent duplicates',
      );
      return true;
    }
    // Re-push messages so retries can re-process them
    const existing = pendingMessages.get(chatJid) || [];
    pendingMessages.set(chatJid, [...messages, ...existing]);
    logger.warn(
      { group: group.name },
      'Agent error, re-buffered messages for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update KV state snapshot for container to read
  const kvState = getAllKvStateForGroup(group.folder);
  writeStateSnapshot(group.folder, kvState);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Handle an inbound message event from the MCP bridge.
 * Dispatches directly to the group queue — no intermediate DB table.
 */
function onInboxEvent(event: import('./types.js').InboxEvent): void {
  const jid =
    getChannelMapping(event.channel, event.chatId) ||
    (event.chatId.includes('@') ? event.chatId : undefined);
  if (!jid) return;

  // Skip bot messages: agent responses are prefixed with "AssistantName:"
  if (event.content.startsWith(`${ASSISTANT_NAME}:`)) {
    logger.debug({ jid }, 'Skipping bot-prefixed message');
    return;
  }

  // Bootstrap: auto-register first DM as main group when no groups exist
  if (
    Object.keys(registeredGroups).length === 0 &&
    !event.metadata?.isGroup &&
    !event.metadata?.isBotMessage
  ) {
    registerGroup(jid, {
      name: 'Main',
      folder: MAIN_GROUP_FOLDER,
      trigger: ASSISTANT_NAME,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
    logger.info(
      { jid },
      'Bootstrap: auto-registered first DM as main group',
    );
  }

  const group = registeredGroups[jid];
  if (!group) return;

  const messageId =
    event.messageId ||
    `mcp-${event.channel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const msg: NewMessage = {
    id: messageId,
    chat_jid: jid,
    sender: event.sender,
    sender_name: event.senderName,
    content: event.content,
    timestamp: event.timestamp,
  };

  // Buffer the message
  const buffer = pendingMessages.get(jid);
  if (buffer) {
    buffer.push(msg);
  } else {
    pendingMessages.set(jid, [msg]);
  }

  // Dispatch
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  if (queue.sendMessage(jid, formatMessages([msg]))) {
    // Active container received the message — clear it from the buffer
    const buf = pendingMessages.get(jid);
    if (buf) {
      const idx = buf.indexOf(msg);
      if (idx !== -1) buf.splice(idx, 1);
    }
    logger.debug({ jid }, 'Piped message to active container');
  } else if (isMainGroup || group.requiresTrigger === false) {
    // Main group or no-trigger group: always dispatch
    queue.enqueueMessageCheck(jid);
  } else {
    // Non-main group with trigger required: check for trigger
    if (TRIGGER_PATTERN.test(msg.content.trim())) {
      queue.enqueueMessageCheck(jid);
    }
    // Otherwise: silently accumulate — buffer holds context for when trigger arrives
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Load skill system
  skills = loadSkills();
  setLoadedSkills(skills);

  // Start MCP bridges for skills with persistent MCP servers
  const mcpSkills = skills.filter((s) => s.manifest.mcp);
  if (mcpSkills.length > 0) {
    await startMcpBridges({
      skills: mcpSkills,
      onInboxEvent,
    });
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await stopMcpBridges();
    await queue.shutdown(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await sendToJid(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => sendToJid(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    resolveSkillForJid: (jid) => resolveSkillForJid(skills, jid),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
