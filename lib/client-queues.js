// Only anonymous numeric session IDs cross into status; never expose interest
// keys (which include tile coordinates), source addresses or focus locations.
const priorities = ['requested', 'neighbours', 'zoom'];
const counts = () => ({ requested: 0, neighbours: 0, zoom: 0 });
function interestClients(interests) {
  const ids = new Set();
  for (const interest of interests.values()) {
    if (interest.live && !interest.live()) continue;
    for (const id of interest.clients?.() || []) if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}
function summarizeClientQueues(entries) {
  const groups = new Map();
  for (const { state, priority, clients = [] } of entries) {
    if (!['rendering', 'waiting'].includes(state) || !priorities[priority]) continue;
    const ids = [...new Set(clients.filter(id => Number.isSafeInteger(id) && id > 0))];
    const id = ids.length > 1 ? 'shared' : ids.length ? `client-${ids[0]}` : 'other';
    if (!groups.has(id)) groups.set(id, { id, rendering: counts(), waiting: counts() });
    groups.get(id)[state][priorities[priority]]++;
  }
  return [...groups.values()];
}
function mergeClientQueues(...sources) {
  const groups = new Map();
  for (const row of sources.flat()) {
    if (!groups.has(row.id)) groups.set(row.id, { id: row.id, rendering: counts(), waiting: counts() });
    for (const state of ['rendering', 'waiting']) for (const priority of priorities) groups.get(row.id)[state][priority] += row[state][priority];
  }
  const rank = id => id === 'shared' ? Number.MAX_SAFE_INTEGER - 1 : id === 'other' ? Number.MAX_SAFE_INTEGER : Number(id.slice(7));
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
module.exports = { interestClients, summarizeClientQueues, mergeClientQueues };
