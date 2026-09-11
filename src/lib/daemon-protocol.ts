import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { daemonIdentityFingerprint } from './scope-collection.js';

export const DAEMON_PROTOCOL_VERSION = 1;

export function getDaemonSocketPath(): string {
  const config = loadConfig();
  return path.join(os.homedir(), '.ki', 'run', `daemon-${daemonIdentityFingerprint(config)}.sock`);
}
