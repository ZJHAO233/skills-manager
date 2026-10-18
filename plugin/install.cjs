'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function installFolder(sourcePath, baseDir, skillName, { fs: io = fs } = {}) {
  if (typeof skillName !== 'string' || !skillName || skillName === '.' || skillName === '..' ||
      /[<>:"/\\|?*\x00-\x1f]/.test(skillName) || /[. ]$/.test(skillName) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(skillName) ||
      /^\.skill-(?:install|backup)-/i.test(skillName)) {
    throw new Error('技能名称必须是安全的文件夹名称，不能包含路径或系统保留名称。');
  }
  const originalDestination = path.resolve(baseDir, skillName);
  let destination = originalDestination;
  let stage;
  let backupPath;
  let movedOld = false;
  function statIfPresent(target) {
    try { return io.lstatSync(target); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  function checkSource(target) {
    const stat = io.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`源目录不能包含符号链接或目录联接：${target}`);
    if (stat.isDirectory()) {
      for (const name of io.readdirSync(target)) { if (name.toLowerCase() !== '.git') checkSource(path.join(target, name)); }
    } else if (!stat.isFile()) {
      throw new Error(`源目录包含不支持的文件类型：${target}`);
    }
  }
  function checkDestination() {
    const stat = statIfPresent(destination);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`安装目标必须是普通目录，不能是符号链接或目录联接：${destination}`);
    }
    return stat;
  }
  try {
    checkSource(sourcePath);
    if (!io.lstatSync(sourcePath).isDirectory()) throw new Error('安装源必须是文件夹。');
    const source = io.realpathSync(sourcePath);
    io.mkdirSync(baseDir, { recursive: true });
    const base = io.realpathSync(baseDir);
    const relativeBase = path.relative(source, base);
    if (!relativeBase || (!relativeBase.startsWith(`..${path.sep}`) && relativeBase !== '..' && !path.isAbsolute(relativeBase))) {
      throw new Error('安装目录不能位于源文件夹内。');
    }
    let destinationName = skillName;
    if (process.platform === 'win32') {
      destinationName = io.readdirSync(base).find(name => name.toLowerCase() === skillName.toLowerCase()) || skillName;
    }
    destination = path.join(base, destinationName);
    checkDestination();
    stage = io.mkdtempSync(path.join(base, '.skill-install-'));
    io.cpSync(source, stage, { recursive: true, dereference: false, filter: target => {
      if (path.relative(source, target).split(path.sep).some(part => part.toLowerCase() === '.git')) return false;
      const stat = io.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`源目录包含不安全的文件：${target}`);
      }
      return true;
    } });
    if (checkDestination()) {
      backupPath = path.join(base, `.skill-backup-${skillName}-${randomUUID()}`);
      io.renameSync(destination, backupPath);
      movedOld = true;
    }
    if (statIfPresent(destination)) throw new Error(`安装目标已发生变化：${destination}`);
    io.renameSync(stage, destination);
    stage = undefined;
    return backupPath ? { destination, backupPath } : { destination };
  } catch (cause) {
    let rollbackError;
    if (movedOld) {
      try {
        if (statIfPresent(destination)) throw new Error('目标已被其他程序创建，未覆盖该目标。');
        io.renameSync(backupPath, destination);
        movedOld = false;
      } catch (error) { rollbackError = error; }
    }
    const permission = ['EPERM', 'EBUSY', 'EACCES'].includes(cause.code);
    const error = new Error(`${permission ? '安装失败：目录被占用或无访问权限，请关闭占用程序并检查目录权限。' : '安装失败。'}\n实际目标：${destination}\n原始目标：${originalDestination}\n${cause.message}${rollbackError ? `\n恢复失败，旧目录保留于：${backupPath}\n${rollbackError.message}` : ''}`, { cause });
    if (cause.code) error.code = cause.code;
    if (movedOld) error.backupPath = backupPath;
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  } finally {
    if (stage) {
      try { io.rmSync(stage, { recursive: true, force: true }); } catch { /* Only disposable staging content may be removed. */ }
    }
  }
}

async function installFolderAsync(sourcePath, baseDir, skillName, { onProgress } = {}) {
  if (typeof skillName !== 'string' || !skillName || skillName === '.' || skillName === '..' ||
      /[<>:"/\\|?*\x00-\x1f]/.test(skillName) || /[. ]$/.test(skillName) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(skillName) ||
      /^\.skill-(?:install|backup)-/i.test(skillName)) {
    throw new Error('技能名称必须是安全的文件夹名称，不能包含路径或系统保留名称。');
  }
  const io = fs.promises;
  const originalDestination = path.resolve(baseDir, skillName);
  let destination = originalDestination;
  let stage;
  let backupPath;
  let movedOld = false;
  async function statIfPresent(target) {
    try { return await io.lstat(target); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function checkDestination() {
    const stat = await statIfPresent(destination);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`安装目标必须是普通目录，不能是符号链接或目录联接：${destination}`);
    }
    return stat;
  }
  const entries = [];
  let total = 0;
  let totalBytes = 0;
  async function collect(target, relative = '') {
    const stat = await io.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`源目录不能包含符号链接或目录联接：${target}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`源目录包含不支持的文件类型：${target}`);
    entries.push({ relative, directory: stat.isDirectory(), size: stat.size });
    if (stat.isDirectory()) {
      for (const name of await io.readdir(target)) {
        if (name.toLowerCase() !== '.git') await collect(path.join(target, name), path.join(relative, name));
      }
    } else {
      total++;
      totalBytes += stat.size;
    }
  }
  try {
    await collect(sourcePath);
    if (!entries[0].directory) throw new Error('安装源必须是文件夹。');
    const source = await io.realpath(sourcePath);
    await io.mkdir(baseDir, { recursive: true });
    const base = await io.realpath(baseDir);
    const relativeBase = path.relative(source, base);
    if (!relativeBase || (!relativeBase.startsWith(`..${path.sep}`) && relativeBase !== '..' && !path.isAbsolute(relativeBase))) {
      throw new Error('安装目录不能位于源文件夹内。');
    }
    let destinationName = skillName;
    if (process.platform === 'win32') {
      destinationName = (await io.readdir(base)).find(name => name.toLowerCase() === skillName.toLowerCase()) || skillName;
    }
    destination = path.join(base, destinationName);
    await checkDestination();
    stage = await io.mkdtemp(path.join(base, '.skill-install-'));
    let current = 0;
    let bytes = 0;
    const progress = () => { if (onProgress) onProgress({ stage: 'install', current, total, bytes, totalBytes }); };
    progress();
    for (const entry of entries) {
      const from = path.join(source, entry.relative);
      const to = path.join(stage, entry.relative);
      const stat = await io.lstat(from);
      if (stat.isSymbolicLink() || (entry.directory ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`源目录包含不安全的文件：${from}`);
      }
      if (entry.directory) {
        await io.mkdir(to, { recursive: true });
      } else {
        await io.copyFile(from, to);
        current++;
        bytes += entry.size;
        progress();
      }
    }
    if (await checkDestination()) {
      backupPath = path.join(base, `.skill-backup-${skillName}-${randomUUID()}`);
      await io.rename(destination, backupPath);
      movedOld = true;
    }
    if (await statIfPresent(destination)) throw new Error(`安装目标已发生变化：${destination}`);
    await io.rename(stage, destination);
    stage = undefined;
    return backupPath ? { destination, backupPath } : { destination };
  } catch (cause) {
    let rollbackError;
    if (movedOld) {
      try {
        if (await statIfPresent(destination)) throw new Error('目标已被其他程序创建，未覆盖该目标。');
        await io.rename(backupPath, destination);
        movedOld = false;
      } catch (error) { rollbackError = error; }
    }
    const permission = ['EPERM', 'EBUSY', 'EACCES'].includes(cause.code);
    const error = new Error(`${permission ? '安装失败：目录被占用或无访问权限，请关闭占用程序并检查目录权限。' : '安装失败。'}\n实际目标：${destination}\n原始目标：${originalDestination}\n${cause.message}${rollbackError ? `\n恢复失败，旧目录保留于：${backupPath}\n${rollbackError.message}` : ''}`, { cause });
    if (cause.code) error.code = cause.code;
    if (movedOld) error.backupPath = backupPath;
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  } finally {
    if (stage) {
      try { await io.rm(stage, { recursive: true, force: true }); } catch { /* Only disposable staging content may be removed. */ }
    }
  }
}

module.exports = { installFolder, installFolderAsync };
