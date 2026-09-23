import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const jitiPackagePath = require.resolve('jiti/package.json');
const jitiPackage = JSON.parse(readFileSync(jitiPackagePath, 'utf8'));
const jitiBin = typeof jitiPackage.bin === 'string' ? jitiPackage.bin : jitiPackage.bin?.jiti;

if (typeof jitiBin !== 'string') {
  throw new Error('The installed jiti package does not declare a jiti executable.');
}

export const jitiCliPath = path.resolve(path.dirname(jitiPackagePath), jitiBin);
