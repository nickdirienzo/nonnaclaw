import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { OutboxEvent } from './types.js';

/**
 * Write an outbox event for a skill to process.
 * Uses atomic temp-file-then-rename to prevent partial reads.
 */
export function writeOutboxEvent(skillName: string, event: OutboxEvent): void {
  const outboxDir = path.join(DATA_DIR, 'events', 'outbox', skillName);
  fs.mkdirSync(outboxDir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(outboxDir, filename);
  const tempPath = `${filepath}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(event, null, 2));
  fs.renameSync(tempPath, filepath);

  logger.debug(
    { skillName, jid: event.jid, type: event.type },
    'Outbox event written',
  );
}
