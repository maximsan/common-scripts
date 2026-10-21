// tools/nmclean-timing.mjs - times each step of the nmclean dry run. Reads only. Run it from your repos folder:
//   node <path-to>/nmclean-timing.mjs
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const repos = (await readdir(root)).map((name) => path.join(root, name))
  .filter((dir) => existsSync(path.join(dir, '.git')));
const folders = repos.map((dir) => path.join(dir, 'node_modules')).filter((dir) => existsSync(dir));

async function oneAtATime(dir) {
  let files = 0;
  const stack = [dir];
  for (let current = stack.pop(); current; current = stack.pop()) {
    for (const name of await readdir(current).catch(() => [])) {
      const info = await lstat(path.join(current, name)).catch(() => null);
      if (info?.isDirectory() && !info.isSymbolicLink()) stack.push(path.join(current, name));
      else if (info) files += 1;
    }
  }
  return files;
}

async function folderAtOnce(dir) {
  let files = 0;
  const stack = [dir];
  for (let current = stack.pop(); current; current = stack.pop()) {
    const names = await readdir(current).catch(() => []);
    const infos = await Promise.all(names.map((name) => lstat(path.join(current, name)).catch(() => null)));
    infos.forEach((info, index) => {
      if (info?.isDirectory() && !info.isSymbolicLink()) stack.push(path.join(current, names[index]));
      else if (info) files += 1;
    });
  }
  return files;
}

async function typesOnly(dir) {
  let files = 0;
  const stack = [dir];
  for (let current = stack.pop(); current; current = stack.pop()) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else files += 1;
    }
  }
  return files;
}

async function time(label, work) {
  const started = performance.now();
  const result = await work();
  console.log(`${label.padEnd(36)} ${String(Math.round(performance.now() - started)).padStart(7)} ms  ${result}`);
}

console.log(`${repos.length} repos, ${folders.length} with node_modules, Node ${process.version}, ${process.platform}\n`);
await time('git ls-files, every repo', async () => {
  for (const dir of repos) execFileSync('git', ['-C', dir, 'ls-files', '-z'], { maxBuffer: 1e9 });
  return '';
});
await time('git check-ignore, every node_modules', async () => {
  for (const dir of folders) {
    try { execFileSync('git', ['-C', path.dirname(dir), 'check-ignore', '-q', 'node_modules/']); } catch {}
  }
  return '';
});
for (const [label, walk] of [['today: one file at a time', oneAtATime], ['A: a folder at once', folderAtOnce],
  ['B: names and types only', typesOnly]]) {
  await time(label, async () => {
    let files = 0;
    for (const dir of folders) files += await walk(dir);
    return `${files} files`;
  });
}
