'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyAgentPath: classify}=require('./agent-paths.js');
const agents=[{id:'openclaw',path:'skills',absolutePaths:['C:/Users/Joel/skills']},{id:'codex',path:'.codex/skills',absolutePaths:['C:/Users/Joel/.codex/skills','E:/Data/Codex/skills']},{id:'claudecode',path:'.claude/skills',absolutePaths:['C:/Users/Joel/.claude/skills']}];
test('specific Codex paths and mapped real paths do not match OpenClaw',()=>{assert.equal(classify('C:\\Users\\Joel\\.codex\\skills\\ppt',agents),'codex');assert.equal(classify('E:/Data/Codex/skills/ppt',agents),'codex');});
test('matches actual OpenClaw root but not generic custom skills directory',()=>{assert.equal(classify('C:/Users/Joel/skills/ppt',agents),'openclaw');assert.equal(classify('D:/custom/skills/ppt',agents),'');assert.equal(classify('C:/Users/Joel/.codex/skills-extra/ppt',agents),'');});
test('other tool and longest exact boundary take priority',()=>{assert.equal(classify('C:/Users/Joel/.claude/skills/ppt',agents),'claudecode');assert.equal(classify('C:/Users/Joel/.codex/skills/ppt', [...agents,{id:'nested',absolutePaths:['C:/Users/Joel/.codex/skills/ppt']}]),'nested');});
test('legacy relative patterns use segment boundaries and exclude generic skills',()=>{assert.equal(classify('C:/Users/Joel/.codex/skills/ppt',agents.map(({absolutePaths,...a})=>a)),'codex');assert.equal(classify('D:/custom/skills/ppt',[{id:'openclaw',path:'skills'}]),'');});
