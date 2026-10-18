'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDownloader } = require('./download.cjs');
const url = 'https://example.invalid/team/repo.git';

function fixture(t, behavior, timers = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai_skills_preview_test_'));
  const target = path.join(parent, 'repo');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const calls = [];
  const downloader = createDownloader({
    idleMs: 100, attemptMs: 200, totalMs: 400, killGraceMs: 30,
    ...timers,
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.pid = calls.length + 100;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kills = 0;
      child.kill = () => {
        child.kills++;
        setImmediate(() => child.emit('close', null));
        return true;
      };
      calls.push({ command, args, options, child });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'partial'), 'test');
      setImmediate(() => behavior(child, calls.length));
      return child;
    }
  });
  return { downloader, target, calls };
}

test('stderr and stdout progress, safe arguments and guarded callbacks', async t => {
  const f = fixture(t, child => {
    child.stderr.emit('data', Buffer.from('Receiving objects: 20%\r'));
    child.stdout.emit('data', Buffer.from('done\n'));
    child.emit('close', 0);
  });
  const events = [];
  await f.downloader.clone(url, f.target, event => { events.push(event); throw Error('UI'); });
  assert.ok(events.some(event => event.type === 'info' && event.text.includes('20%')));
  assert.ok(events.some(event => event.text === 'done\n'));
  assert.deepEqual(f.calls[0].args, ['clone', '--progress', '--depth', '1', '--no-tags', '--', url, f.target]);
  assert.equal(f.calls[0].options.shell, false);
  assert.ok(fs.existsSync(f.target));
});

for (const [text, code] of [
  ['fatal: Authentication failed', 'AUTH_OR_NOT_FOUND'],
  ['fatal: repository not found', 'AUTH_OR_NOT_FOUND'],
  ['SSL certificate problem', 'CERTIFICATE_ERROR'],
  ['fatal: Permission denied', 'FILESYSTEM_ERROR'],
  ['fatal: No space left on device', 'FILESYSTEM_ERROR']
]) test(`fatal ${code}: ${text}`, async t => {
  const f = fixture(t, child => { child.stderr.emit('data', Buffer.from(text)); child.emit('close', 128); });
  await assert.rejects(f.downloader.clone(url, f.target), { code });
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(f.target), false);
});

test('ENOENT is fatal without echoing arbitrary spawn error', async t => {
  const f = fixture(t, child => {
    child.pid = undefined;
    child.emit('error', Object.assign(Error('secret'), { code: 'ENOENT' }));
    child.emit('close', -1);
  });
  await assert.rejects(f.downloader.clone(url, f.target), error => error.code === 'GIT_NOT_FOUND' && !error.message.includes('secret'));
  assert.equal(f.calls.length, 1);
});

test('network retries direct once, cleans only after close', async t => {
  let target;
  const f = fixture(t, (child, attempt) => {
    if (attempt === 1) {
      child.stderr.emit('data', Buffer.from('Connection reset by peer\n'));
      assert.ok(fs.existsSync(target));
      child.emit('close', 128);
      child.emit('close', 128);
    } else child.emit('close', 0);
  });
  target = f.target;
  await f.downloader.clone(url, target);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args.at(-2), url);
});

test('idle timeout kills and waits before retry, then rejects bounded', async t => {
  const f = fixture(t, child => {
    child.kill = () => {
      child.kills++;
      assert.ok(fs.existsSync(f.target));
      setTimeout(() => child.emit('close', null), 5);
      return true;
    };
  }, { idleMs: 15, totalMs: 200 });
  await assert.rejects(f.downloader.clone(url, f.target), { code: 'IDLE_TIMEOUT' });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.child.kills === 1));
  assert.equal(fs.existsSync(f.target), false);
});

test('total deadline survives progress and spans retries', async t => {
  const f = fixture(t, (child, attempt) => {
    if (attempt === 1) {
      setTimeout(() => { child.stderr.emit('data', Buffer.from('Connection reset\n')); child.emit('close', 1); }, 20);
    } else {
      const timer = setInterval(() => child.stderr.emit('data', Buffer.from('progress\r')), 3);
      child.once('close', () => clearInterval(timer));
    }
  }, { idleMs: 40, totalMs: 55, attemptMs: 150 });
  await assert.rejects(f.downloader.clone(url, f.target), { code: 'TOTAL_TIMEOUT' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].child.kills, 1);
});

test('attempt deadline cannot be extended by progress', async t => {
  const f = fixture(t, child => {
    const timer = setInterval(() => child.stdout.emit('data', Buffer.from('progress\n')), 3);
    child.once('close', () => clearInterval(timer));
  }, { idleMs: 50, attemptMs: 15, totalMs: 200 });
  await assert.rejects(f.downloader.clone(url, f.target), { code: 'ATTEMPT_TIMEOUT' });
  assert.equal(f.calls.length, 2);
});

test('cancelAll kills, waits, cleans, and never retries', async t => {
  const f = fixture(t, () => {});
  const promise = f.downloader.clone(url, f.target);
  const rejected = assert.rejects(promise, { code: 'CANCELLED' });
  await f.downloader.cancelAll();
  await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].child.kills, 1);
  assert.equal(fs.existsSync(f.target), false);
});

test('missing close refuses cleanup; late close never retries or deletes', async t => {
  const f = fixture(t, child => { child.kill = () => { child.kills++; return true; }; }, { idleMs: 10, killGraceMs: 10 });
  await assert.rejects(f.downloader.clone(url, f.target), error => {
    assert.equal(error.code, 'PROCESS_STILL_RUNNING');
    assert.equal(error.preventCleanup, true);
    return true;
  });
  assert.ok(fs.existsSync(f.target));
  f.calls[0].child.emit('close', null);
  f.calls[0].child.emit('close', null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 1);
  assert.ok(fs.existsSync(f.target));
});

test('validates credentials, schemes, injection and target without spawn or deletion', async t => {
  const f = fixture(t, () => {});
  for (const invalid of ['https://user:password@example.invalid/repo', 'file:///tmp/repo', '--upload-pack=evil', 'https://example.invalid/repo\n--evil']) {
    await assert.rejects(f.downloader.clone(invalid, f.target), { code: 'INVALID_URL' });
  }
  await assert.rejects(f.downloader.clone(url, path.dirname(f.target)), { code: 'UNSAFE_TARGET' });
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, 'keep'), 'safe');
  await assert.rejects(f.downloader.clone(url, f.target), { code: 'UNSAFE_TARGET' });
  assert.ok(fs.existsSync(path.join(f.target, 'keep')));
  assert.equal(f.calls.length, 0);
});

test('sanitizes split credentials and bounds retained diagnostics', async t => {
  const f = fixture(t, child => {
    for (const part of ['https://user:pass', 'word@example.invalid/repo?token=secret\n', 'Authorization: Bear', 'er private\n', 'password=hunter2\n', 'x'.repeat(6000) + '\n', 'fatal: unknown\n']) child.stderr.emit('data', Buffer.from(part));
    child.emit('close', 1);
  });
  const logs = [];
  await assert.rejects(f.downloader.clone(url, f.target, event => logs.push(event.text)), error => {
    assert.ok(error.stderrTail.length <= 4096);
    assert.doesNotMatch(error.message, /password|hunter2|private|secret|user:pass/);
    return true;
  });
  assert.doesNotMatch(logs.join(''), /hunter2|private|secret|user:pass/);
});

test('mirrors are only used when explicitly supplied', async t => {
  const f = fixture(t, (child, attempt) => {
    child.stderr.emit('data', Buffer.from('Connection reset\n'));
    child.emit('close', attempt === 3 ? 0 : 1);
  });
  await f.downloader.clone(url, f.target, null, { mirrors: ['https://mirror.invalid/'] });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].args.at(-2), 'https://mirror.invalid/' + url);
});
