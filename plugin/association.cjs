'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_METADATA = 1024 * 1024;
const TTL = 10 * 60 * 1000;

function repository(value) {
  if (typeof value !== 'string') throw new Error('Invalid GitHub repository');
  const match = value.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[2] === '.' || match[2] === '..') throw new Error('Invalid GitHub repository');
  return `https://github.com/${match[1]}/${match[2]}`;
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
async function identity(localPath) {
  const realPath = await fs.realpath(localPath);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) throw new Error('Skill root is not a directory');
  if (!samePath(await fs.realpath(localPath), realPath)) throw new Error('Skill root changed');
  return { realPath, dev: stat.dev, ino: stat.ino };
}
async function verifyRoot(localPath, expected) {
  const actual = await identity(localPath);
  if (!samePath(actual.realPath, expected.realPath) || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Skill root changed');
}
async function readMetadata(file) {
  let before;
  try { before = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Metadata must be a direct regular file');
  if (before.size > MAX_METADATA) throw new Error('Metadata exceeds 1 MiB');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Metadata changed');
    if (stat.size > MAX_METADATA) throw new Error('Metadata exceeds 1 MiB');
    const data = Buffer.alloc(MAX_METADATA + 1);
    let size = 0;
    while (size < data.length) {
      const result = await handle.read(data, size, data.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_METADATA) throw new Error('Metadata exceeds 1 MiB');
    const after = await fs.lstat(file);
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error('Metadata changed');
    return data.subarray(0, size);
  } finally { await handle.close(); }
}
async function atomicWrite(file, content, validate = async () => {}) {
  const temporary = path.join(path.dirname(file), `.association-${randomUUID()}.tmp`);
  try {
    await validate();
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await validate();
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
function candidate(skill) {
  if (!skill || typeof skill.path !== 'string' || !skill.path || skill.path.includes('\\') || skill.path.includes('\0') || (skill.path !== '.' && skill.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')))) throw new Error('Invalid repository skill path');
  return { name: skill.name, path: skill.path, description: skill.description };
}

function createAssociations({ getSkills, previewRepo, loadRegistry, saveRegistry, invalidate = () => {}, cleanup = tempDir => fs.rm(tempDir, { recursive: true, force: true }) }) {
  const pending = new Map();
  let commits = Promise.resolve();
  async function resolveSkill(skillPath) {
    if (typeof skillPath !== 'string' || !path.isAbsolute(skillPath)) throw new Error('Unknown skill');
    const skills = await getSkills();
    const skill = skills.find(item => item.localPath === skillPath);
    if (!skill) throw new Error('Unknown skill');
    return skill;
  }
  async function preview(skillPath, repo) {
    const skill = await resolveSkill(skillPath);
    const root = await identity(skill.localPath);
    const normalizedRepo = repository(repo);
    let result;
    let token;
    try {
      result = await previewRepo(normalizedRepo);
      const skills = result.skills.map(candidate);
      if (!skills.length) throw new Error('No repository skills found');
      await verifyRoot(skill.localPath, root);
      for (const [key, record] of pending) if (record.expires <= Date.now()) pending.delete(key);
      token = randomUUID();
      pending.set(token, { localPath: skill.localPath, id: skill.id, root, repo: normalizedRepo, skills, expires: Date.now() + TTL });
      return { token, skills: skills.map(item => ({ ...item })), repo: normalizedRepo };
    } finally {
      if (result && result.tempDir) {
        try { await cleanup(result.tempDir); } catch {}
      }
    }
  }
  async function commit(token, selectedPath) {
    const record = pending.get(token);
    if (!record || record.expires <= Date.now()) { pending.delete(token); throw new Error('Unknown or expired association token'); }
    if (!record.skills.some(skill => skill.path === selectedPath)) throw new Error('Unknown selected repository path');
    pending.delete(token);
    const skill = await resolveSkill(record.localPath);
    if (skill.id !== record.id) throw new Error('Skill identity changed');
    const validate = () => verifyRoot(record.localPath, record.root);
    await validate();
    const file = path.join(record.root.realPath, 'metadata.json');
    const backup = await readMetadata(file);
    const metadata = backup === null ? {} : JSON.parse(backup.toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid skill metadata');
    const registry = await loadRegistry();
    const index = registry.findIndex(item => item.localPath === record.localPath);
    const entry = { ...(index < 0 ? skill : registry[index]), id: (index < 0 ? skill.id : registry[index].id) || randomUUID(), sourceUrl: record.repo, release: null, sourcePath: selectedPath, associationPending: true };
    const nextRegistry = registry.map(item => ({ ...item }));
    if (index < 0) nextRegistry.push(entry); else nextRegistry[index] = entry;
    const updated = { ...metadata, source_url: record.repo, type: 'git', release: null, source_path: selectedPath, associated_at: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(updated, null, 2), validate);
    try { await validate(); await saveRegistry(nextRegistry); }
    catch (error) {
      try {
        if (backup === null) { await validate(); await fs.unlink(file); }
        else await atomicWrite(file, backup, validate);
      } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Association failed and metadata rollback failed'); }
      throw error;
    }
    await invalidate();
    return entry;
  }
  return {
    preview,
    commit(token, selectedPath) {
      const result = commits.then(() => commit(token, selectedPath));
      commits = result.catch(() => {});
      return result;
    }
  };
}

module.exports = { createAssociations };
