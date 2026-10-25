import { spawn } from 'node:child_process';
const children = [];
const node = spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit' });
const client = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:client'], { stdio: 'inherit' });
children.push(node, client);
const stop = () => { for (const p of children) p.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const p of children) p.on('exit', (code) => { if (code && code !== 0) { stop(); process.exitCode = code; } });
