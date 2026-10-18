'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {readDocs}=require('./docs.cjs');
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'skill-docs-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('prefers Chinese README, offers README and SKILL as tabs, preserves literal text',async t=>{const d=await setup(t);await fs.writeFile(path.join(d,'README.md'),'# Usage <script>no()</script>');await fs.writeFile(path.join(d,'README_CN.md'),'# 中文');await fs.writeFile(path.join(d,'SKILL.md'),'skill');const docs=await readDocs(d);assert.deepEqual(docs.map(f=>f.name),['README_CN.md','README.md','SKILL.md']);assert.ok(docs[1].text.includes('<script>'));});
test('falls back to SKILL.md and rejects missing files',async t=>{const d=await setup(t);await assert.rejects(readDocs(d),/没有 README/);await fs.writeFile(path.join(d,'SKILL.md'),'hello');assert.equal((await readDocs(d))[0].text,'hello');});
test('rejects relative and oversized paths',async t=>{const d=await setup(t);await assert.rejects(readDocs('relative'));await fs.writeFile(path.join(d,'README.md'),Buffer.alloc(1048577));await assert.rejects(readDocs(d),/超过/);});
test('allows a junction ancestor of the selected skill',async t=>{
  const d=await setup(t),target=path.join(d,'target'),link=path.join(d,'skills');
  await fs.mkdir(path.join(target,'example'),{recursive:true});
  await fs.writeFile(path.join(target,'example','README.md'),'ancestor junction');
  await fs.symlink(target,link,'junction');
  assert.equal((await readDocs(path.join(link,'example')))[0].text,'ancestor junction');
});
test('allows a selected root junction',async t=>{
  const d=await setup(t),target=path.join(d,'target'),link=path.join(d,'selected');
  await fs.mkdir(target);await fs.writeFile(path.join(target,'README.md'),'root junction');
  await fs.symlink(target,link,'junction');
  assert.equal((await readDocs(link))[0].text,'root junction');
});
test('rejects a README symlink without opening the outside document',async t=>{
  const d=await setup(t),root=path.join(d,'skill'),outside=path.join(d,'outside.md');
  await fs.mkdir(root);await fs.writeFile(outside,'outside document');
  try {await fs.symlink(outside,path.join(root,'README.md'),'file');}
  catch(error){if(error.code==='EPERM'||error.code==='EACCES'){t.skip('File symlink permission unavailable');return;}throw error;}
  t.mock.method(fs,'open',async()=>assert.fail('Linked document must not be opened'));
  await assert.rejects(readDocs(root),/链接/);
});
test('rejects an outside file substituted at open before reading its content',async t=>{
  const d=await setup(t),root=path.join(d,'skill'),outside=path.join(d,'outside.md');
  await fs.mkdir(root);await fs.writeFile(path.join(root,'README.md'),'inside');await fs.writeFile(outside,'outside');
  const open=fs.open;let reads=0,closed=false;
  t.mock.method(fs,'open',async()=>{
    const handle=await open(outside,'r');
    return {stat:()=>handle.stat(),read:async()=>{reads++;assert.fail('Outside content must not be read');},close:async()=>{closed=true;await handle.close();}};
  });
  await assert.rejects(readDocs(root),/文件已变化/);
  assert.equal(reads,0);assert.equal(closed,true);
});
for(const phase of ['before','after'])test('rejects selected root junction mapping swapped '+phase+' reading',async t=>{
  const d=await setup(t),first=path.join(d,'first'),second=path.join(d,'second'),link=path.join(d,'selected');
  await fs.mkdir(first);await fs.mkdir(second);
  await fs.writeFile(path.join(first,'README.md'),'original');await fs.writeFile(path.join(second,'README.md'),'outside');
  await fs.symlink(first,link,'junction');
  const swap=async()=>{await fs.unlink(link);await fs.symlink(second,link,'junction');};
  const open=fs.open;let reads=0;
  if(phase==='before'){
    const readdir=fs.readdir;
    t.mock.method(fs,'readdir',async(...args)=>{const names=await readdir(...args);await swap();return names;});
    t.mock.method(fs,'open',async()=>assert.fail('Changed root must not be opened'));
  }else{
    t.mock.method(fs,'open',async(...args)=>{
      const handle=await open(...args);
      return {stat:()=>handle.stat(),read:async(...readArgs)=>{reads++;const result=await handle.read(...readArgs);if(reads===1)await swap();return result;},close:()=>handle.close()};
    });
  }
  await assert.rejects(readDocs(link),/目录已变化/);
});
test('rejects root identity replacement even when its realpath stays unchanged',async t=>{
  const d=await setup(t),root=path.join(d,'skill');await fs.mkdir(root);await fs.writeFile(path.join(root,'README.md'),'original');
  const readdir=fs.readdir;
  t.mock.method(fs,'readdir',async(...args)=>{
    const names=await readdir(...args);await fs.rename(root,path.join(d,'old'));
    await fs.mkdir(root);await fs.writeFile(path.join(root,'README.md'),'replacement');return names;
  });
  t.mock.method(fs,'open',async()=>assert.fail('Replaced root must not be opened'));
  await assert.rejects(readDocs(root),/目录已变化/);
});
