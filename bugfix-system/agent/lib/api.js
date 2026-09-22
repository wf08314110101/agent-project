import { cfg } from '../../server/config.js';

async function req(method, url, body, raw = false) {
  const res = await fetch(cfg.serverUrl + url, {
    method,
    headers: {
      'x-agent-token': cfg.agentToken,
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: (await res.text()).slice(0, 300)`);
  return raw ? res : res.json();
}

export const api = {
  claim: () => req('POST', '/agent/claim'),
  heartbeat: (batchId) => req('POST', '/agent/heartbeat', { batch_id: batchId }),
  report: (payload) => req('POST', '/agent/report', payload),
  commands: () => req('GET', '/agent/commands'),
  reportMerge: (payload) => req('POST', '/agent/report-merge', payload),
  downloadAttachment: async (id, dest) => {
    const res = await req('GET', `/agent/attachments/${id}`, null, true);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  },
};
