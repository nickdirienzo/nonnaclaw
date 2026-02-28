/**
 * WhatsApp Skill — Persistent Service
 *
 * Connects to WhatsApp via Baileys, writes inbound messages to the inbox,
 * and polls the outbox to send messages. Managed by NanoClaw's persistent
 * skill scheduler (auto-restarts on exit).
 */
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

// --- Environment (set by NanoClaw skill-inbound scheduler) ---

const INBOX_DIR = process.env.NANOCLAW_INBOX_DIR!;
const OUTBOX_DIR = process.env.NANOCLAW_OUTBOX_DIR!;
const STORE_DIR = process.env.NANOCLAW_STORE_DIR!;
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Assistant';
const ASSISTANT_HAS_OWN_NUMBER = process.env.ASSISTANT_HAS_OWN_NUMBER === 'true';

if (!INBOX_DIR || !OUTBOX_DIR || !STORE_DIR) {
  console.error('Missing required env: NANOCLAW_INBOX_DIR, NANOCLAW_OUTBOX_DIR, NANOCLAW_STORE_DIR');
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OUTBOX_POLL_MS = 500;

// --- Helpers ---

interface InboxEvent {
  channel: string;
  chatId: string;
  type?: 'message' | 'chat_metadata';
  content: string;
  sender: string;
  senderName: string;
  timestamp: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

interface OutboxEvent {
  type: 'message' | 'typing';
  jid: string;
  text?: string;
  isTyping?: boolean;
  sender?: string;
  timestamp: string;
}

function writeInboxEvent(event: InboxEvent): void {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(INBOX_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(event, null, 2));
  fs.renameSync(tempPath, filepath);
}

// --- LID translation ---

const lidToPhoneMap: Record<string, string> = {};

async function translateJid(sock: WASocket, jid: string): Promise<string> {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];

  const cached = lidToPhoneMap[lidUser];
  if (cached) return cached;

  try {
    const pn = await (sock as any).signalRepository?.lidMapping?.getPNForLID(jid);
    if (pn) {
      const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
      lidToPhoneMap[lidUser] = phoneJid;
      logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
      return phoneJid;
    }
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to resolve LID');
  }

  return jid;
}

// --- Outbox poller ---

let outboxTimer: ReturnType<typeof setTimeout> | null = null;

function startOutboxPoller(sock: WASocket): void {
  const poll = async () => {
    try {
      if (!fs.existsSync(OUTBOX_DIR)) {
        outboxTimer = setTimeout(poll, OUTBOX_POLL_MS);
        return;
      }

      const files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json')).sort();

      for (const file of files) {
        const filePath = path.join(OUTBOX_DIR, file);
        try {
          const event: OutboxEvent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fs.unlinkSync(filePath);

          if (event.type === 'message' && event.text) {
            const text = ASSISTANT_HAS_OWN_NUMBER
              ? event.text
              : `${ASSISTANT_NAME}: ${event.text}`;
            await sock.sendMessage(event.jid, { text });
            logger.info({ jid: event.jid, length: text.length }, 'Outbox message sent');
          } else if (event.type === 'typing') {
            const status = event.isTyping ? 'composing' : 'paused';
            await sock.sendPresenceUpdate(status, event.jid).catch(() => {});
          }
        } catch (err) {
          logger.error({ file, err }, 'Error processing outbox event');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading outbox directory');
    }

    outboxTimer = setTimeout(poll, OUTBOX_POLL_MS);
  };

  poll();
}

// --- Group sync ---

let lastGroupSync = 0;

async function syncGroupMetadata(sock: WASocket): Promise<void> {
  if (Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
    logger.debug('Skipping group sync - synced recently');
    return;
  }

  try {
    logger.info('Syncing group metadata...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        writeInboxEvent({
          channel: 'whatsapp',
          chatId: jid,
          type: 'chat_metadata',
          content: '',
          sender: '',
          senderName: '',
          timestamp: new Date().toISOString(),
          metadata: { name: metadata.subject, isGroup: true },
        });
        count++;
      }
    }

    lastGroupSync = Date.now();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

// --- Main connection ---

async function connect(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
    logger.warn({ err }, 'Failed to fetch latest WA Web version, using default');
    return { version: undefined };
  });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    printQRInTerminal: false,
    logger: logger as any,
    browser: Browsers.macOS('Chrome'),
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.error('WhatsApp authentication required. Run auth script first.');
      process.exit(1);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (outboxTimer) clearTimeout(outboxTimer);

      if (shouldReconnect) {
        // Exit cleanly — persistent scheduler will restart us
        process.exit(0);
      } else {
        logger.error('Logged out. Re-run auth script.');
        process.exit(1);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');

      sock.sendPresenceUpdate('available').catch((err) => {
        logger.warn({ err }, 'Failed to send presence update');
      });

      // Build LID to phone mapping for self-chat
      if (sock.user) {
        const phoneUser = sock.user.id.split(':')[0];
        const lidUser = sock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
        }
      }

      // Start outbox poller
      startOutboxPoller(sock);

      // Sync group metadata
      syncGroupMetadata(sock);
      setInterval(() => syncGroupMetadata(sock), GROUP_SYNC_INTERVAL_MS);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      const chatJid = await translateJid(sock, rawJid);
      const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
      const isGroup = chatJid.endsWith('@g.us');

      // Always emit chat_metadata for group discovery
      writeInboxEvent({
        channel: 'whatsapp',
        chatId: chatJid,
        type: 'chat_metadata',
        content: '',
        sender: '',
        senderName: '',
        timestamp,
        metadata: { isGroup },
      });

      // Extract text content
      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      if (!content) continue;

      const sender = msg.key.participant || msg.key.remoteJid || '';
      const senderName = msg.pushName || sender.split('@')[0];
      const fromMe = msg.key.fromMe || false;

      const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
        ? fromMe
        : content.startsWith(`${ASSISTANT_NAME}:`);

      writeInboxEvent({
        channel: 'whatsapp',
        chatId: chatJid,
        content,
        sender,
        senderName,
        timestamp,
        messageId: msg.key.id || undefined,
        metadata: { isBotMessage, isFromMe: fromMe },
      });
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    if (outboxTimer) clearTimeout(outboxTimer);
    sock.end(undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

connect().catch((err) => {
  logger.error({ err }, 'Failed to start WhatsApp service');
  process.exit(1);
});
