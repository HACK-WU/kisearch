import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { daemonIdentityFingerprint } from './scope-collection.js';

export const DAEMON_PROTOCOL_VERSION = 1;

export function getDaemonSocketPath(): string {
  const config = loadConfig();
  const daemonIdentity = daemonIdentityFingerprint(config);
  if (process.platform === 'win32') {
    // Windows IPC is a machine-wide named-pipe namespace, not a filesystem socket.
    // Include the home-directory hash to keep identical configs isolated per account.
    const userIdentity = createHash('sha256')
      .update(path.resolve(os.homedir()).toLowerCase())
      .digest('hex')
      .slice(0, 12);
    return `\\\\.\\pipe\\kisearch-${userIdentity}-${daemonIdentity}`;
  }
  return path.join(os.homedir(), '.ki', 'run', `daemon-${daemonIdentity}.sock`);
}
