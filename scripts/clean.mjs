// Removes build output and packaged extensions without needing an extra dependency.
import { readdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
for (const file of readdirSync('.')) {
  if (file.endsWith('.vsix')) {
    rmSync(file, { force: true });
  }
}
