import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import dotenv from 'dotenv';

const PATH_KEYS = new Set([
  'DATA_DIR', 'ACCOUNTS_CONFIG_PATH', 'CONTEXT_DIR', 'EXPORTS_DIR', 'DB_PATH',
  'BROWSER_DATA_PATH', 'BROWSER_COOKIES_PATH', 'LINKEDIN_IMPORTS_DIR',
]);

export async function initializeInstance({ projectRoot, instanceDir = path.join(projectRoot, 'instance') }) {
  const templateDir = path.join(projectRoot, 'instance_example');
  if (await statOrNull(path.join(instanceDir, '.env'))) {
    throw new Error('Found instance/.env. Run instance:migrate to move it to the repository root before initialization.');
  }
  const copies = [
    ['.env.example', '.env'],
    ['accounts.json.example', 'accounts.json'],
    ['context/voice.example.yaml', 'context/voice.yaml'],
    ['context/bio.example.yaml', 'context/bio.yaml'],
    ['context/platforms.example.yaml', 'context/platforms.yaml'],
    ['context/projects/_template.yaml', 'context/projects/_template.yaml'],
    ['context/personas/_template.yaml', 'context/personas/_template.yaml'],
  ];
  const created = [];
  for (const [source, destination] of copies) {
    const target = path.join(destination === '.env' ? projectRoot : instanceDir, destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.copyFile(path.join(templateDir, source), target, constants.COPYFILE_EXCL);
      if (destination === '.env') await fs.chmod(target, 0o600);
      created.push(destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  for (const directory of ['data/imports', 'data/exports', 'data/nyra']) {
    await fs.mkdir(path.join(instanceDir, directory), { recursive: true });
  }
  return { instanceDir, created };
}

export async function migrateLegacyInstance({ projectRoot, instanceDir = path.join(projectRoot, 'instance') }) {
  projectRoot = await fs.realpath(projectRoot);
  instanceDir = path.resolve(instanceDir);
  assertInside(projectRoot, instanceDir);
  // Moving into a source directory would recursively move it into itself.
  for (const reserved of ['src', 'data', 'templates', 'instance_example', '.git']) {
    if (isWithin(path.join(projectRoot, reserved), instanceDir)) throw new Error(`Invalid instance destination: ${instanceDir}`);
  }
  const lockPath = path.join(projectRoot, '.instance-migration.lock');
  const lock = await fs.open(lockPath, 'wx');
  try {
    await assertNoSymlinkParents(projectRoot, instanceDir);
    const pairs = [
      [path.relative(projectRoot, path.join(instanceDir, '.env')), path.join(projectRoot, '.env')],
      ['src/config/accounts.json', 'accounts.json'],
      ['src/context', 'context'],
      ['data', 'data'],
      ['debug.log', 'data/logs/debug.log'],
    ];
    const moves = [];
    for (const [sourceName, destinationName] of pairs) {
      const source = path.resolve(projectRoot, sourceName);
      const target = path.resolve(instanceDir, destinationName);
      assertInside(projectRoot, source);
      if (target !== path.join(projectRoot, '.env')) assertInside(instanceDir, target);
      const sourceStat = await statOrNull(source);
      if (!sourceStat) continue;
      if (sourceStat.isSymbolicLink()) throw new Error(`Refusing to migrate a symbolic link: ${sourceName}`);
      if (await statOrNull(target)) throw new Error(`Migration conflict: ${target} already exists. Nothing has been moved. Migrate before instance:init, or resolve the conflicting files manually.`);
      moves.push({ source, target, sourceName });
    }
    const dataDir = path.join(projectRoot, 'data');
    const dataEntries = await fs.readdir(dataDir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (dataEntries.some(name => name.endsWith('.scrape.lock'))) {
      throw new Error('A scrape lock exists. Stop collection and resolve the lock before migrating the instance.');
    }
    const envTarget = path.join(projectRoot, '.env');
    const envMove = moves.find(move => move.target === envTarget);
    const originalEnv = envMove ? await fs.readFile(envMove.source, 'utf8')
      : (await statOrNull(envTarget) ? await fs.readFile(envTarget, 'utf8') : null);
    const moved = [];
    try {
      for (const move of moves) {
        await fs.mkdir(path.dirname(move.target), { recursive: true });
        await fs.rename(move.source, move.target);
        moved.push(move);
      }
      if (originalEnv !== null) {
        // An intermediate instance/.env already has rebased paths. Only rebase
        // a legacy root .env when legacy data/config locations actually move.
        const rebase = !envMove && moves.some(move =>
          ['data', 'src/context', 'src/config/accounts.json'].includes(move.sourceName));
        const updatedEnv = rebase ? rewriteLegacyPaths(originalEnv, { projectRoot, instanceDir }) : originalEnv;
        await fs.writeFile(envTarget, updatedEnv, { mode: 0o600 });
        await fs.chmod(envTarget, 0o600);
      }
    } catch (error) {
      if (originalEnv !== null && (!envMove || moved.includes(envMove))) await fs.writeFile(envTarget, originalEnv);
      for (const move of moved.reverse()) await fs.rename(move.target, move.source);
      throw error;
    }
    return { instanceDir, moved: moves.map(move => move.sourceName) };
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

export function rewriteLegacyPaths(raw, { projectRoot, instanceDir }) {
  const values = dotenv.parse(raw);
  const mappings = [
    [path.join(projectRoot, 'src', 'config', 'accounts.json'), path.join(instanceDir, 'accounts.json')],
    [path.join(projectRoot, 'src', 'context'), path.join(instanceDir, 'context')],
    [path.join(projectRoot, 'data'), path.join(instanceDir, 'data')],
  ];
  return raw.replace(/^(\s*(?:export\s+)?)([A-Z_]+)(\s*=\s*)([^\r\n]*)/gm, (line, prefix, key, separator) => {
    if (!PATH_KEYS.has(key) || !values[key]) return line;
    const previous = path.resolve(projectRoot, values[key]);
    const mapping = mappings.find(([source]) => isWithin(source, previous));
    const target = mapping ? path.join(mapping[1], path.relative(mapping[0], previous)) : previous;
    // Explicit custom locations remain absolute; standard paths move with the instance.
    const value = isWithin(instanceDir, target) ? path.relative(instanceDir, target) || '.' : target;
    return `${prefix}${key}${separator}${JSON.stringify(value.split(path.sep).join('/'))}`;
  });
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInside(root, target) {
  if (root === target || !isWithin(root, target)) throw new Error(`Path must stay inside ${root}: ${target}`);
}

async function statOrNull(target) {
  try { return await fs.lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoSymlinkParents(root, target) {
  for (let current = target; current !== root; current = path.dirname(current)) {
    const stat = await statOrNull(current);
    if (stat?.isSymbolicLink()) throw new Error(`Instance destination contains a symbolic link: ${current}`);
  }
}
