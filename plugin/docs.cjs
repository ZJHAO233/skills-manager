'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const LIMIT = 1024 * 1024;
async function readDocs(folder) {
  if (!path.isAbsolute(folder)) throw new Error('Skill 目录必须是绝对路径');
  const root = await fs.realpath(folder);
  const identity = await fs.lstat(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Skill 目录已变化，请重新打开');
  async function validateRoot() {
    const mapped = await fs.realpath(folder);
    const current = await fs.lstat(root);
    if (mapped !== root || current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Skill 目录已变化，请重新打开');
  }
  async function validateFile(file, previous) {
    await validateRoot();
    const current = await fs.lstat(file);
    if (current.isSymbolicLink() || path.dirname(file) !== root || await fs.realpath(file) !== file) throw new Error('说明文件路径包含链接，已停止读取');
    if (!current.isFile() || current.size > LIMIT) throw new Error(path.basename(file) + ' 不是普通文件或超过 1 MiB，无法预览');
    if (previous && (current.dev !== previous.dev || current.ino !== previous.ino)) throw new Error('文件已变化，请重新打开');
    return current;
  }
  await validateRoot();
  const names = await fs.readdir(root);
  const priorities = ['readme_zh-cn.md', 'readme.zh-cn.md', 'readme_cn.md', 'readme_zh.md', 'readme.md', 'readme.txt', 'readme', 'skill.md'];
  const files = [];
  for (const key of priorities) {
    const name = names.find(n => n.toLowerCase() === key); if (!name) continue;
    const file = path.join(root, name);
    const before = await validateFile(file);
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > LIMIT) throw new Error('文件已变化，请重新打开');
      await validateFile(file, before);
      const bytes = Buffer.alloc(LIMIT + 1); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      if (offset > LIMIT) throw new Error('说明文件超过 1 MiB，无法预览');
      await validateFile(file, before);
      files.push({ name, text: bytes.subarray(0, offset).toString('utf8') });
    } finally { await handle.close(); }
  }
  await validateRoot();
  if (!files.length) throw new Error('此 Skill 目录没有 README 或 SKILL.md，可使用打开目录手动查看');
  return files;
}
module.exports = { readDocs };
