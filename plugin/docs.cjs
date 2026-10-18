'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const LIMIT = 1024 * 1024;
async function noLinks(target) {
  const absolute = path.resolve(target); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('说明文件路径包含链接，已停止读取');
  }
}
async function readDocs(folder) {
  if (!path.isAbsolute(folder)) throw new Error('Skill 目录必须是绝对路径');
  await noLinks(folder);
  const names = await fs.readdir(folder);
  const priorities = ['readme_zh-cn.md', 'readme.zh-cn.md', 'readme_cn.md', 'readme_zh.md', 'readme.md', 'readme.txt', 'readme', 'skill.md'];
  const files = [];
  for (const key of priorities) {
    const name = names.find(n => n.toLowerCase() === key); if (!name) continue;
    const file = path.join(folder, name); await noLinks(file);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.size > LIMIT) throw new Error(name + ' 不是普通文件或超过 1 MiB，无法预览');
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > LIMIT) throw new Error('文件已变化，请重新打开');
      const bytes = Buffer.alloc(LIMIT + 1); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      if (offset > LIMIT) throw new Error('说明文件超过 1 MiB，无法预览');
      await noLinks(file); files.push({ name, text: bytes.subarray(0, offset).toString('utf8') });
    } finally { await handle.close(); }
  }
  if (!files.length) throw new Error('此 Skill 目录没有 README 或 SKILL.md，可使用打开目录手动查看');
  return files;
}
module.exports = { readDocs };
