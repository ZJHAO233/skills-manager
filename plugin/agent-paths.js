'use strict';
(function (root) {
  function classifyAgentPath(value, agents) {
    if (typeof value !== 'string' || !value) return '';
    const normalize = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = normalize(value);
    const matches = [];
    for (const agent of agents) {
      for (const candidate of agent.absolutePaths || []) {
        const base = normalize(candidate);
        if (base && (target === base || target.startsWith(base + '/'))) matches.push({ id: agent.id, length: base.length });
      }
      if (agent.absolutePaths?.length) continue;
      const relative = normalize(agent.path || '').replace(/^\/+/, '');
      if (!relative || !relative.includes('/')) continue;
      if (('/' + target.replace(/^\/+/, '')).includes('/' + relative + '/')) matches.push({ id: agent.id, length: relative.length });
    }
    matches.sort((a, b) => b.length - a.length);
    return matches[0]?.id || '';
  }
  root.classifyAgentPath = classifyAgentPath;
  if (typeof module !== 'undefined' && module.exports) module.exports = { classifyAgentPath };
})(typeof window !== 'undefined' ? window : globalThis);
