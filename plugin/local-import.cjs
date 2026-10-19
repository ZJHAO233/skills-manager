'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MiB = 1024 * 1024;
const MAX_FILE = 10 * MiB;
const MAX_TOTAL = 100 * MiB;
const MAX_ZIP = 50 * MiB;
const MAX_ENTRIES = 20000;
const MAX_DEPTH = 12;
const SKIP = new Set(['.git', 'node_modules']);

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function selectedPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw fail('INVALID_LOCAL_PATH', '请选择本地文件或文件夹。');
  return path.resolve(value);
}
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
async function ordinary(target, directory) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw fail('UNSAFE_LOCAL_PATH', '本地导入不支持符号链接、目录联接或特殊文件。');
  }
  return stat;
}
async function unchanged(target) {
  if (!samePath(await fs.realpath(target), target)) throw fail('UNSAFE_LOCAL_PATH', '本地源路径已改变或包含符号链接。');
}
async function readBounded(target, limit) {
  await unchanged(target);
  const before = await ordinary(target, false);
  if (before.size > limit) throw fail('LOCAL_LIMIT', '本地文件大小超过导入限制。');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw fail('UNSAFE_LOCAL_PATH', '本地源文件已发生变化。');
    if (stat.size > limit) throw fail('LOCAL_LIMIT', '本地文件大小超过导入限制。');
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw fail('LOCAL_LIMIT', '本地文件大小超过导入限制。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await unchanged(target);
    const after = await ordinary(target, false);
    if (after.dev !== stat.dev || after.ino !== stat.ino) throw fail('UNSAFE_LOCAL_PATH', '本地源文件已发生变化。');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
function description(text) {
  const front = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) return '';
  const lines = front[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^description:\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  return '';
}
async function previewFolder(folder) {
  const originalPath = selectedPath(folder);
  await ordinary(originalPath, true);
  // Resolve an ancestor alias once, while disallowing links beneath the selected root.
  const root = await fs.realpath(originalPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai_skills_preview_'));
  const cloneDir = path.join(tempDir, 'repo');
  const skills = [];
  let count = 0;
  let total = 0;
  async function copy(source, target, relative, depth) {
    await unchanged(source);
    await ordinary(source, true);
    await fs.mkdir(target, { mode: 0o700 });
    const directory = await fs.opendir(source);
    for await (const entry of directory) {
      if (SKIP.has(entry.name.toLowerCase())) continue;
      if (++count > MAX_ENTRIES) throw fail('LOCAL_LIMIT', '本地文件条目数量超过 20000 个的限制。');
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      const stat = await fs.lstat(from);
      if (stat.isSymbolicLink()) throw fail('UNSAFE_LOCAL_PATH', '本地源目录不能包含符号链接或目录联接。');
      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) throw fail('LOCAL_LIMIT', '本地目录深度超过 12 层限制。');
        await copy(from, to, relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
      } else if (stat.isFile()) {
        const content = await readBounded(from, Math.min(MAX_FILE, MAX_TOTAL - total));
        total += content.length;
        await fs.writeFile(to, content, { flag: 'wx', mode: 0o600 });
        if (/^skill\.md$/i.test(entry.name)) {
          if (skills.some(skill => skill.path === (relative || '.'))) throw fail('UNSAFE_LOCAL_PATH', '同一文件夹包含多个 SKILL.md 文件。');
          skills.push({ name: relative ? path.basename(source) : path.basename(originalPath), path: relative || '.', description: description(content.toString('utf8')) });
        }
      } else throw fail('UNSAFE_LOCAL_PATH', '本地源目录包含不支持的特殊文件。');
    }
    await unchanged(source);
  }
  try {
    await copy(root, cloneDir, '', 0);
    if (!skills.length) throw fail('NO_SKILLS', '所选文件夹中未找到 SKILL.md 技能包。');
    skills.sort((a, b) => a.path.localeCompare(b.path));
    return { tempDir, cloneDir, skills, gitUrl: '', local: { kind: 'folder', originalPath }, sourceType: 'local' };
  } catch (error) {
    try { await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch {}
    throw error;
  }
}
async function previewZip(file) {
  const originalPath = selectedPath(file);
  if (!/\.zip$/i.test(originalPath)) throw fail('INVALID_LOCAL_FILE', '请选择 ZIP 格式文件。');
  await ordinary(originalPath, false);
  const canonical = await fs.realpath(originalPath);
  const buffer = await readBounded(canonical, MAX_ZIP);
  const name = path.basename(originalPath).slice(0, -4);
  const result = await require('./release.cjs').prepareArchive(buffer, { name });
  return {
    tempDir: result.tempDir,
    cloneDir: result.cloneDir,
    skills: result.skills.map(skill => ({ ...skill, name: !skill.path || skill.path === '.' ? name : path.posix.basename(skill.path.replace(/\\/g, '/')) })),
    gitUrl: '',
    local: { kind: 'zip', originalPath },
    sourceType: 'local'
  };
}

module.exports = { previewFolder, previewZip };
