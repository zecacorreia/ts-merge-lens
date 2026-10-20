import fs from 'node:fs';

function readVersion(): string {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
    if (typeof manifest.version === 'string') return manifest.version;
  }
  return '0.0.0';
}

export const VERSION = readVersion();
