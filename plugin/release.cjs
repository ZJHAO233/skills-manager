'use strict';

const https = require('node:https');
const tls = require('node:tls');
const agent = new https.Agent({ ca: [...tls.rootCertificates, ...(typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : [])] });
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setImmediate: yieldImmediate } = require('node:timers/promises');
const JSZip = require('./vendor/jszip.js');

const MiB = 1024 * 1024;
const MAX_ZIP = 50 * MiB;
const MAX_FILE = 10 * MiB;
const MAX_TOTAL = 100 * MiB;
const MAX_ENTRIES = 20000;
const HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function trusted(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('UNSAFE_URL', 'Invalid release download URL.'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw fail('UNSAFE_URL', 'Release downloads must use trusted GitHub HTTPS hosts.');
  }
  return url;
}
function sourceURL(value, repo) {
  const url = trusted(value);
  const prefix = url.hostname === 'api.github.com' ? `/repos/${repo}/zipball/` : url.hostname === 'codeload.github.com' ? `/${repo}/zip/` : null;
  if (!prefix || !url.pathname.startsWith(prefix) || url.pathname.length === prefix.length || url.search || url.hash) {
    throw fail('UNSAFE_URL', 'Source snapshots must use the repository GitHub ZIP endpoint.');
  }
  return url.href;
}
function progress(callback, event) {
  if (typeof callback === 'function') {
    try { callback({ type: 'info', ...event }); } catch {}
  }
}
function repository(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_REPOSITORY', 'Use a GitHub repository URL.'); }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match) {
    throw fail('INVALID_REPOSITORY', 'Use an HTTPS GitHub repository URL without credentials or query parameters.');
  }
  const owner = match[1];
  const name = match[2].replace(/\.git$/, '');
  if ([owner, name].some(part => !part || part === '.' || part === '..')) throw fail('INVALID_REPOSITORY', 'Invalid GitHub repository.');
  return `${owner}/${name}`;
}
function transfer(value, limit, onProgress, redirects = 0, signal) {
  return new Promise((resolve, reject) => {
    const url = trusted(value);
    const req = https.get(url, { agent, signal, headers: { 'User-Agent': 'AI-Skills-Release-Preview', Accept: 'application/vnd.github+json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(fail('REDIRECT_LIMIT', 'Too many release redirects.'));
        let next;
        try { next = trusted(new URL(res.headers.location, url).href).href; } catch (error) { reject(error); return; }
        resolve(transfer(next, limit, onProgress, redirects + 1, signal));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(fail('HTTP_ERROR', `GitHub returned HTTP ${res.statusCode}.`)); return; }
      const length = Number(res.headers['content-length']);
      const total = Number.isSafeInteger(length) && length >= 0 ? length : null;
      if (total > limit) { res.destroy(); reject(fail('DOWNLOAD_TOO_LARGE', 'Response exceeds the download limit.')); return; }
      const chunks = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { res.destroy(); reject(fail('DOWNLOAD_TOO_LARGE', 'Response exceeds the download limit.')); return; }
        chunks.push(chunk);
        progress(onProgress, { stage: 'download', current: size, total, text: `Downloading release: ${size} bytes` });
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => req.destroy(fail('NETWORK_TIMEOUT', 'GitHub request timed out.')));
    const timer = setTimeout(() => req.destroy(fail('NETWORK_TIMEOUT', 'GitHub request exceeded its time limit.')), 180000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}
function safeName(name) {
  if (typeof name !== 'string' || !name || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) throw fail('UNSAFE_ARCHIVE', 'Unsafe archive path.');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw fail('UNSAFE_ARCHIVE', 'Unsafe Windows archive path.');
  }
  return parts.join('/');
}
function checkNames(entries) {
  const seen = new Map();
  const spellings = new Map();
  for (const entry of entries) {
    const original = safeName(entry.name);
    const parts = original.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join('/');
      const key = spelling.normalize('NFC').toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== spelling) throw fail('UNSAFE_ARCHIVE', 'Case-colliding archive directories.');
      spellings.set(key, spelling);
    }
    const name = original.normalize('NFC').toLowerCase();
    if (seen.has(name)) throw fail('UNSAFE_ARCHIVE', 'Duplicate or case-colliding archive paths.');
    seen.set(name, entry.dir);
  }
  for (const name of seen.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/')) === false) throw fail('UNSAFE_ARCHIVE', 'Archive file/directory collision.');
    }
  }
}
// JSZip normalizes paths and overwrites duplicate names, so inspect the original directory first.
function inspectDirectory(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw fail('UNSAFE_ARCHIVE', 'Invalid or multi-volume ZIP.');
  const invalid = () => fail('UNSAFE_ARCHIVE', 'ZIP 中央目录或 ZIP64 结构无效。');
  function uint64(offset) {
    const value = buffer.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    return Number(value);
  }
  let count = buffer.readUInt16LE(end + 10);
  let diskCount = buffer.readUInt16LE(end + 8);
  let directoryOffset = buffer.readUInt32LE(end + 16);
  let directorySize = buffer.readUInt32LE(end + 12);
  let footer = end;
  const hasZip64 = end >= 20 && buffer.readUInt32LE(end - 20) === 0x07064b50;
  if (hasZip64) {
    const locator = end - 20;
    if (buffer.readUInt32LE(locator + 4) !== 0 || buffer.readUInt32LE(locator + 16) !== 1) throw invalid();
    footer = uint64(locator + 8);
    if (footer > locator - 56 || buffer.readUInt32LE(footer) !== 0x06064b50) throw invalid();
    const recordSize = uint64(footer + 4);
    if (recordSize < 44 || recordSize !== locator - footer - 12 || buffer.readUInt32LE(footer + 16) || buffer.readUInt32LE(footer + 20)) throw invalid();
    const zip64Count = uint64(footer + 32);
    const zip64DiskCount = uint64(footer + 24);
    const zip64Size = uint64(footer + 40);
    const zip64Offset = uint64(footer + 48);
    if ((count !== 0xffff && count !== zip64Count) || (diskCount !== 0xffff && diskCount !== zip64DiskCount) ||
        (directorySize !== 0xffffffff && directorySize !== zip64Size) || (directoryOffset !== 0xffffffff && directoryOffset !== zip64Offset)) throw invalid();
    count = zip64Count;
    diskCount = zip64DiskCount;
    directorySize = zip64Size;
    directoryOffset = zip64Offset;
  } else if (count === 0xffff || diskCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw invalid();
  if (count > MAX_ENTRIES) throw fail('ARCHIVE_LIMIT', `ZIP 文件条目数量超过 ${MAX_ENTRIES} 个的限制。`);
  let cursor = directoryOffset;
  const directoryEnd = cursor + directorySize;
  if (!Number.isSafeInteger(directoryEnd) || directoryEnd > footer || diskCount !== count) throw invalid();
  function signature(start, stop) {
    return stop - start >= 6 && buffer.readUInt32LE(start) === 0x05054b50 && buffer.readUInt16LE(start + 4) === stop - start - 6;
  }
  if (directoryEnd !== footer && !signature(directoryEnd, footer)) throw invalid();
  const entries = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    let size = buffer.readUInt32LE(cursor + 24);
    let compressed = buffer.readUInt32LE(cursor + 20);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    let disk = buffer.readUInt16LE(cursor + 34);
    const flags = buffer.readUInt16LE(cursor + 8);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const length = buffer.readUInt16LE(cursor + 28);
    const next = cursor + 46 + length + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (next > directoryEnd) throw invalid();
    const extraStart = cursor + 46 + length;
    const extraEnd = extraStart + buffer.readUInt16LE(cursor + 30);
    let zip64 = -1;
    let zip64End = -1;
    for (let extra = extraStart; extra < extraEnd;) {
      if (extra + 4 > extraEnd) throw invalid();
      const extraNext = extra + 4 + buffer.readUInt16LE(extra + 2);
      if (extraNext > extraEnd) throw invalid();
      if (buffer.readUInt16LE(extra) === 1) {
        if (zip64 !== -1) throw invalid();
        zip64 = extra + 4;
        zip64End = extraNext;
      }
      extra = extraNext;
    }
    function extraValue(bytes) {
      if (zip64 < 0 || zip64 + bytes > zip64End) throw invalid();
      const value = bytes === 8 ? uint64(zip64) : buffer.readUInt32LE(zip64);
      zip64 += bytes;
      return value;
    }
    if (size === 0xffffffff) size = extraValue(8);
    if (compressed === 0xffffffff) compressed = extraValue(8);
    if (localOffset === 0xffffffff) localOffset = extraValue(8);
    if (disk === 0xffff) disk = extraValue(4);
    if (disk || localOffset > directoryOffset - 30 || buffer.readUInt32LE(localOffset) !== 0x04034b50 || compressed > directoryOffset - localOffset - 30) throw invalid();
    if (flags & 1 || (mode & 0xf000) === 0xa000 || ((mode & 0xf000) && ![0x4000, 0x8000].includes(mode & 0xf000))) throw fail('UNSAFE_ARCHIVE', 'Encrypted or special archive entries are unsupported.');
    total += size;
    if (size > MAX_FILE || total > MAX_TOTAL) throw fail('ARCHIVE_LIMIT', 'Archive extraction size limit exceeded.');
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    entries.push({ name, dir: name.endsWith('/'), size });
    cursor = next;
  }
  if (cursor !== directoryEnd) throw fail('UNSAFE_ARCHIVE', 'Invalid ZIP directory length.');
  checkNames(entries);
  const sizes = new Map(entries.map(entry => [entry.name, entry.size]));
  if (footer !== end || directoryEnd !== end) {
    // JSZip treats unrecognized footer bytes as a prepended offset when EOCD fields are not sentinels.
    const classicEnd = Buffer.from(buffer.subarray(end));
    classicEnd.writeUInt16LE(count, 8);
    classicEnd.writeUInt16LE(count, 10);
    classicEnd.writeUInt32LE(directorySize, 12);
    classicEnd.writeUInt32LE(directoryOffset, 16);
    return { buffer: Buffer.concat([buffer.subarray(0, directoryEnd), classicEnd]), sizes };
  }
  return { buffer, sizes };
}
function inflate(entry, declaredSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const stream = entry.internalStream('nodebuffer');
    stream.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_FILE || size > declaredSize) {
        failed = true;
        stream.pause();
        reject(fail('ARCHIVE_LIMIT', 'Decompressed entry exceeds its declared size.'));
      } else chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (size !== declaredSize) reject(fail('UNSAFE_ARCHIVE', 'Archive entry size mismatch.'));
      else resolve(Buffer.concat(chunks));
    });
    stream.resume();
  });
}
function metadata(text, fallback) {
  const values = {};
  const front = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (front) {
    const lines = front[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(name|description):\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (/^[>|][-+]?$/.test(value)) {
        const block = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
        value = block.join(value.startsWith('>') ? ' ' : '\n');
      } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  }
  return { name: values.name || fallback, description: values.description || '' };
}
function checkCancelled(signal) {
  if (signal.aborted) throw fail('CANCELLED', 'Release download cancelled.');
}
async function prepareArchive(buffer, { name = 'local-skill', onProgress, signal = new AbortController().signal } = {}) {
  checkCancelled(signal);
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP) throw fail('DOWNLOAD_TOO_LARGE', 'Invalid or oversized release download.');
  const inspected = inspectDirectory(buffer);
  const zip = await JSZip.loadAsync(inspected.buffer, { createFolders: false });
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw fail('ARCHIVE_LIMIT', `ZIP 文件条目数量超过 ${MAX_ENTRIES} 个的限制。`);
  checkNames(entries);
  let total = 0;
  for (const entry of entries) {
    safeName(entry.unsafeOriginalName || entry.name);
    if ((Number(entry.unixPermissions) & 0xf000) === 0xa000) throw fail('UNSAFE_ARCHIVE', 'Archive symlinks are forbidden.');
    if (!entry.dir) {
      const size = inspected.sizes.get(entry.unsafeOriginalName || entry.name);
      const loadedSize = entry._data && entry._data.uncompressedSize;
      if (loadedSize !== size && !(size === 0 && loadedSize === undefined)) throw fail('UNSAFE_ARCHIVE', 'Archive entry size mismatch.');
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || (total += size) > MAX_TOTAL) throw fail('ARCHIVE_LIMIT', 'Archive extraction size limit exceeded.');
    }
  }
  const files = entries.filter(e => !e.dir);
  const first = files[0] && files[0].name.split('/')[0];
  const strip = first && files.every(e => e.name.startsWith(first + '/')) && entries.every(e => e.name === first + '/' || e.name.startsWith(first + '/')) ? first + '/' : '';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai_skills_preview_'));
  const cloneDir = path.join(tempDir, 'repo');
  try {
    await fs.mkdir(cloneDir);
    const skills = [];
    let extracted = 0;
    for (const entry of files) {
      checkCancelled(signal);
      const relative = entry.name.slice(strip.length);
      const target = path.join(cloneDir, ...relative.split('/'));
      const content = await inflate(entry, inspected.sizes.get(entry.unsafeOriginalName || entry.name));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 });
      const parts = relative.split('/');
      if (/^skill\.md$/i.test(parts[parts.length - 1]) && !parts.slice(0, -1).some(p => ['.git', 'node_modules'].includes(p.toLowerCase()))) {
        const skillPath = parts.slice(0, -1).join('/') || '.';
        skills.push({ ...metadata(content.toString('utf8'), skillPath === '.' ? name : parts[parts.length - 2]), path: skillPath });
      }
      extracted++;
      progress(onProgress, { stage: 'extract', current: extracted, total: files.length, text: `Extracting release: ${extracted}/${files.length} files` });
      if (extracted % 32 === 0) await yieldImmediate();
    }
    checkCancelled(signal);
    if (!skills.length) throw fail('NO_SKILLS', 'No SKILL.md packages found in the release ZIP.');
    return { tempDir, cloneDir, skills, gitUrl: '' };
  } catch (error) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (cleanupError) {
      progress(onProgress, { text: `[警告] 临时目录清理失败，请稍后手动删除: ${tempDir}\n` });
    }
    throw error;
  }
}
function createReleaseClient({ requestJSON = async (url, { signal } = {}) => JSON.parse((await transfer(url, 5 * MiB, undefined, 0, signal)).toString('utf8')), download = (url, onProgress, { signal } = {}) => transfer(url, MAX_ZIP, onProgress, 0, signal) } = {}) {
  const jobs = new Set();
  function run(operation) {
    const controller = new AbortController();
    const job = { controller, done: null };
    jobs.add(job);
    job.done = Promise.resolve().then(() => operation(controller.signal)).catch(error => {
      checkCancelled(controller.signal);
      throw error;
    }).finally(() => jobs.delete(job));
    return job.done;
  }
  async function fetchReleases(repoUrl, signal) {
    const repo = repository(repoUrl);
    checkCancelled(signal);
    const data = await requestJSON(`https://api.github.com/repos/${repo}/releases?per_page=10`, { signal });
    checkCancelled(signal);
    if (!Array.isArray(data)) throw fail('INVALID_RESPONSE', 'Invalid GitHub releases response.');
    return { repo, releases: data.slice(0, 10).filter(r => !r.draft && !r.prerelease).map(r => ({
      tag: r.tag_name, name: r.name || r.tag_name,
      ...(r.zipball_url ? { source: { tag: r.tag_name, name: 'Source code (ZIP)', size: null, url: sourceURL(r.zipball_url, repo) } } : {}),
      assets: (Array.isArray(r.assets) ? r.assets : []).filter(a => Number.isSafeInteger(a.id) && a.id > 0 && typeof a.name === 'string' && /\.zip$/i.test(a.name) && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_ZIP).map(a => ({ id: a.id, name: a.name, size: a.size, url: trusted(a.browser_download_url).href, digest: a.digest }))
    })) };
  }
  async function list(repoUrl, signal) {
    const result = await fetchReleases(repoUrl, signal);
    return { repo: result.repo, releases: result.releases.map(r => ({ ...r, assets: r.assets.map(({ digest, ...asset }) => asset) })) };
  }
  async function prepare(repoUrl, selection, onProgress, signal) {
    const result = await fetchReleases(repoUrl, signal);
    const isSource = selection && typeof selection === 'object' && selection.kind === 'source' && typeof selection.tag === 'string';
    const assetId = selection && typeof selection === 'object' && selection.kind === 'asset' ? selection.assetId : selection;
    if (!isSource && !Number.isSafeInteger(assetId)) throw fail('UNKNOWN_ASSET', 'Select a release ZIP asset or source snapshot.');
    const release = result.releases.find(r => isSource ? r.tag === selection.tag && r.source : r.assets.some(a => a.id === assetId));
    const asset = release && (isSource ? release.source : release.assets.find(a => a.id === assetId));
    if (!asset) throw fail('UNKNOWN_ASSET', 'Selected ZIP asset or source snapshot is not available in the latest releases.');
    const buffer = await download(trusted(asset.url).href, onProgress, { signal });
    checkCancelled(signal);
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP) throw fail('DOWNLOAD_TOO_LARGE', 'Invalid or oversized release download.');
    if (!isSource && buffer.length !== asset.size) throw fail('SIZE_MISMATCH', 'Release download size does not match GitHub metadata.');
    if (asset.digest) {
      if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest) || crypto.createHash('sha256').update(buffer).digest('hex') !== asset.digest.slice(7).toLowerCase()) throw fail('DIGEST_MISMATCH', 'Release SHA-256 verification failed.');
    }
    const prepared = await prepareArchive(buffer, { name: result.repo.split('/')[1], onProgress, signal });
    return { ...prepared, gitUrl: `https://github.com/${result.repo}`, release: { kind: isSource ? 'source' : 'asset', repo: result.repo, tag: release.tag, assetId: isSource ? null : asset.id, assetName: asset.name } };
  }
  return {
    list: repoUrl => run(signal => list(repoUrl, signal)),
    prepare: (repoUrl, assetId, onProgress) => run(signal => prepare(repoUrl, assetId, onProgress, signal)),
    cancelAll: async () => {
      const active = [...jobs];
      for (const job of active) job.controller.abort();
      return Promise.allSettled(active.map(job => job.done));
    }
  };
}

module.exports = { createReleaseClient, prepareArchive };
