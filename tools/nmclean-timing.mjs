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

// What the re-check before a deletion now does (scanTree): listings, with folders confirmed by lstat.
async function listingsFoldersChecked(dir) {
  let files = 0;
  const stack = [dir];
  for (let current = stack.pop(); current; current = stack.pop()) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    const unclear = entries.filter((entry) => !entry.isFile() && !entry.isSymbolicLink());
    files += entries.length - unclear.length;
    const infos = await Promise.all(unclear.map((entry) => lstat(path.join(current, entry.name)).catch(() => null)));
    infos.forEach((info, index) => {
      if (info?.isDirectory()) stack.push(path.join(current, unclear[index].name));
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

async function timed(work) {
  const started = performance.now();
  const result = await work();
  return { ms: Math.round(performance.now() - started), result };
}

const row = (label, ms, rest = '') => console.log(`${label.padEnd(42)} ${String(ms).padStart(7)} ms  ${rest}`);

console.log(`${repos.length} repos, ${folders.length} with node_modules, Node ${process.version}, ${process.platform}\n`);

const lsFiles = await timed(async () => {
  for (const dir of repos) execFileSync('git', ['-C', dir, 'ls-files', '-z'], { maxBuffer: 1e9 });
});
row('git ls-files, every repo', lsFiles.ms);

const checkIgnore = await timed(async () => {
  for (const dir of folders) {
    try { execFileSync('git', ['-C', path.dirname(dir), 'check-ignore', '-q', 'node_modules/']); } catch {}
  }
});
row('git check-ignore, every node_modules', checkIgnore.ms);

const walkAll = (walk) => timed(async () => {
  let files = 0;
  for (const dir of folders) files += await walk(dir);
  return files;
});

// The first read of a file's details comes from disk, later reads from memory (the cache). A warm-up walk
// fills the cache for every way alike; the rounds then run the ways in a different order each time, and
// the fastest round counts. A cold start, such as the first run after a restart, is not measured here.
const warmUp = await walkAll(folderAtOnce);
row('warm-up walk (not compared)', warmUp.ms, `${warmUp.result} files`);
console.log();

const ways = [
  ['old: one file at a time', oneAtATime],
  ['A: a folder at once (measure)', folderAtOnce],
  ['B: names and types only', typesOnly],
  ['B+: listings, folders checked (re-check)', listingsFoldersChecked],
];
const ROUNDS = 3;
const times = new Map(ways.map(([label]) => [label, []]));

for (let round = 0; round < ROUNDS; round += 1) {
  for (let step = 0; step < ways.length; step += 1) {
    const [label, walk] = ways[(round + step) % ways.length];
    times.get(label).push((await walkAll(walk)).ms);
  }
}

for (const [label, rounds] of times) {
  row(label, Math.min(...rounds), `fastest of ${rounds.join(', ')} ms`);
}
