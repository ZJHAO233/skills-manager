'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function sanitize(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = url.search ? '?[REDACTED]' : '';
        url.hash = '';
        return url.toString();
      } catch { return '[已隐藏网址]'; }
    })
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi, '[认证信息已隐藏]')
    .replace(/\b(?:bearer|basic)\s+[^\s]+/gi, '[认证信息已隐藏]')
    .replace(/\b(?:[\w-]*(?:token|password|passwd|secret|api[_-]?key)[\w-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[凭据已隐藏]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function failure(code, message, tail = '') {
  const error = new Error(message + (tail ? `\n${tail}` : ''));
  error.code = code;
  error.stderrTail = tail;
  return error;
}

function validateUrl(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw failure('INVALID_URL', '仓库地址无效，请使用不含凭据的 HTTP(S) 地址。');
  }
  let url;
  try { url = new URL(value); } catch {
    throw failure('INVALID_URL', '仓库地址无效，请使用 HTTP(S) 地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw failure('INVALID_URL', '仅支持不含用户名或密码的 HTTP(S) 仓库地址。');
  }
  return value;
}

function validateTarget(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target !== path.normalize(target) ||
      path.basename(target) !== 'repo' || !/^ai_skills_preview_.+/.test(path.basename(path.dirname(target)))) {
    throw failure('UNSAFE_TARGET', '下载目录必须是 ai_skills_preview_* 临时目录下的 repo。');
  }
  const parent = fs.lstatSync(path.dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink() || fs.existsSync(target)) {
    throw failure('UNSAFE_TARGET', '下载目录必须是新的临时目录，不能覆盖已有文件。');
  }
}

function classify(tail, cause) {
  if (cause && cause.code === 'ENOENT') return failure('GIT_NOT_FOUND', '未找到 Git，请先安装 Git 并确认 PATH 配置。', tail);
  if (/certificate|ssl|tls|schannel|cert_verify/i.test(tail)) return failure('CERTIFICATE_ERROR', 'Git TLS/证书校验失败，请检查系统证书和代理配置。', tail);
  if (/authentication|authorization|could not read username|terminal prompts disabled|repository.*not found|\b(?:401|403|404)\b|access denied/i.test(tail)) return failure('AUTH_OR_NOT_FOUND', '仓库不存在或无访问权限，请检查仓库地址和授权。', tail);
  if (/permission denied|no space left|disk full|read-only file system|unable to create|cannot create|not enough space/i.test(tail) || (cause && ['EACCES', 'EPERM', 'ENOSPC'].includes(cause.code))) return failure('FILESYSTEM_ERROR', '无法写入下载目录，请检查权限和磁盘剩余空间。', tail);
  if (/could not resolve|failed to connect|connection.*(?:reset|refused|closed|timed out)|network.*(?:unreachable|down)|remote end hung up|early eof|http\/2|rpc failed|recv failure|send failure|empty reply|\b(?:408|429|500|502|503|504)\b|timed? out/i.test(tail)) return failure('NETWORK_ERROR', '网络连接失败，请检查网络或代理后重试。', tail);
  return failure('CLONE_FAILED', 'Git 下载失败，请检查仓库地址和 Git 环境。', tail);
}

function createDownloader({ spawn = childProcess.spawn, now = Date.now, idleMs = 90000, attemptMs = 180000, totalMs = 300000, killGraceMs = 3000 } = {}) {
  for (const value of [idleMs, attemptMs, totalMs, killGraceMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('下载超时时间必须为正数。');
  }
  const jobs = new Set();
  const targets = new Set();

  function clone(gitUrl, cloneDir, onProgress, options = {}) {
    const job = { cancelled: false, stop: null, done: null };
    const emit = text => {
      if (typeof onProgress !== 'function') return;
      try { onProgress({ type: 'info', text: sanitize(text).slice(-4096) }); } catch { /* UI callbacks must not interrupt process supervision. */ }
    };
    job.done = (async () => {
      validateUrl(gitUrl);
      validateTarget(cloneDir);
      if (targets.has(cloneDir)) throw failure('UNSAFE_TARGET', '该临时目录正在下载中。');
      const mirrors = options.mirrors === undefined ? [] : options.mirrors;
      if (!Array.isArray(mirrors)) throw failure('INVALID_URL', '镜像配置必须是地址前缀数组。');
      const urls = [gitUrl, ...mirrors.map(prefix => {
        validateUrl(prefix);
        return validateUrl(prefix + gitUrl);
      })];
      const parentIdentity = fs.realpathSync(path.dirname(cloneDir));
      targets.add(cloneDir);
      jobs.add(job);
      const deadline = now() + totalMs;
      let running = false;
      async function cleanup() {
        if (running) return;
        const parent = fs.lstatSync(path.dirname(cloneDir));
        if (parent.isSymbolicLink() || fs.realpathSync(path.dirname(cloneDir)) !== parentIdentity) {
          throw failure('UNSAFE_TARGET', '临时目录已发生变化，已停止清理。');
        }
        await fs.promises.rm(cloneDir, { recursive: true, force: true });
      }
      function attempt(url) {
        return new Promise((resolve, reject) => {
          let child;
          let tail = '';
          let settled = false;
          let closed = false;
          let stopError = null;
          let spawnError = null;
          let idleTimer;
          let attemptTimer;
          let totalTimer;
          let graceTimer;
          const pending = { stderr: '', stdout: '' };
          const dropping = { stderr: false, stdout: false };
          const flush = stream => {
            if (!pending[stream]) return;
            const text = sanitize(pending[stream]);
            pending[stream] = '';
            if (stream === 'stderr') tail = (tail + text).slice(-4096);
            emit(text);
          };
          const clearTimers = () => {
            for (const timer of [idleTimer, attemptTimer, totalTimer, graceTimer]) clearTimeout(timer);
          };
          const finish = error => {
            if (settled) return;
            settled = true;
            clearTimers();
            job.stop = null;
            if (error) {
              error.stderrTail = tail;
              reject(error);
            } else resolve();
          };
          const stop = error => {
            if (closed || settled || stopError) return;
            flush('stderr');
            flush('stdout');
            stopError = error;
            clearTimers();
            // Killing is asynchronous: the directory remains owned by Git until close.
            graceTimer = setTimeout(() => {
              const error = failure('PROCESS_STILL_RUNNING', 'Git 进程尚未确认退出，请勿删除临时目录。', tail);
              error.processStillRunning = true;
              error.preventCleanup = true;
              finish(error);
            }, killGraceMs);
            try { child.kill(); } catch { /* The close event is still required before cleanup. */ }
          };
          const resetIdle = () => {
            if (settled || stopError) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => stop(failure('IDLE_TIMEOUT', 'Git 长时间没有输出，已停止下载。', tail)), idleMs);
          };
          try {
            child = spawn('git', ['clone', '--progress', '--depth', '1', '--no-tags', '--', url, cloneDir], {
              shell: false,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
            });
            running = true;
          } catch (error) {
            finish(classify('', error));
            return;
          }
          child.on('close', code => {
            if (closed) return;
            closed = true;
            running = false;
            if (settled) {
              jobs.delete(job);
              targets.delete(cloneDir);
              return;
            }
            flush('stderr');
            flush('stdout');
            finish(stopError || (spawnError ? classify(tail, spawnError) : code === 0 ? null : classify(tail)));
          });
          child.on('error', error => {
            if (settled || closed) return;
            spawnError = error;
            if (child.pid == null) {
              running = false;
              finish(classify(tail, error));
            } else stop(classify(tail, error));
          });
          const output = (data, stderr) => {
            if (settled || stopError) return;
            const stream = stderr ? 'stderr' : 'stdout';
            for (const part of data.toString().split(/(?<=[\r\n])/)) {
              if (!dropping[stream]) pending[stream] += part;
              if (/[\r\n]$/.test(part)) {
                flush(stream);
                dropping[stream] = false;
              } else if (pending[stream].length > 8192) {
                pending[stream] = '[过长输出已省略]\n';
                flush(stream);
                dropping[stream] = true;
              }
            }
            resetIdle();
          };
          if (child.stderr) child.stderr.on('data', data => output(data, true));
          if (child.stdout) child.stdout.on('data', data => output(data, false));
          job.stop = () => stop(failure('CANCELLED', '下载已取消。', tail));
          resetIdle();
          attemptTimer = setTimeout(() => stop(failure('ATTEMPT_TIMEOUT', '本次 Git 下载超时，已停止下载。', tail)), attemptMs);
          totalTimer = setTimeout(() => stop(failure('TOTAL_TIMEOUT', '下载总时间已超限，已停止下载。', tail)), Math.max(1, deadline - now()));
          if (job.cancelled) job.stop();
        });
      }
      try {
        for (let index = 0; index < urls.length; index++) {
          const tries = index === 0 ? 2 : 1;
          for (let retry = 0; retry < tries; retry++) {
            if (job.cancelled) throw failure('CANCELLED', '下载已取消。');
            if (now() >= deadline) throw failure('TOTAL_TIMEOUT', '下载总时间已超限，已停止下载。');
            emit(index === 0 ? '[直连] 正在下载仓库…\n' : '[镜像] 正在使用已指定的镜像下载…\n');
            try {
              await attempt(urls[index]);
              return;
            } catch (error) {
              if (error.code === 'PROCESS_STILL_RUNNING') throw error;
              try { await cleanup(); }
              catch (cleanupError) {
                emit(`[警告] 临时目录清理失败，请稍后手动删除: ${cloneDir}\n`);
                throw error;
              }
              if (job.cancelled) throw failure('CANCELLED', '下载已取消。');
              if (!['NETWORK_ERROR', 'IDLE_TIMEOUT', 'ATTEMPT_TIMEOUT'].includes(error.code)) throw error;
              if (now() >= deadline) throw failure('TOTAL_TIMEOUT', '下载总时间已超限，已停止下载。', error.stderrTail);
              if (retry + 1 === tries && index + 1 === urls.length) throw error;
              emit('[重试] 上次连接失败，正在重试…\n');
            }
          }
        }
      } finally {
        if (!running) {
          jobs.delete(job);
          targets.delete(cloneDir);
        }
      }
    })();
    return job.done;
  }

  async function cancelAll() {
    const active = [...jobs];
    for (const job of active) {
      job.cancelled = true;
      if (job.stop) job.stop();
    }
    return Promise.allSettled(active.map(job => job.done));
  }

  return { clone, cancelAll };
}

module.exports = { createDownloader };
