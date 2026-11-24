// Only request arrival changes focus; completion of an old render cannot move it back.
function createRequestFocus({ distance = 8, reprioritize = true, ttlMs = 60000, limit = 256, now = Date.now } = {}) {
  const clients = new Map();
  let sequence = 0;
  const far = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > distance;
  function forget(key) { clients.get(key).active = false; clients.delete(key); }
  return {
    observe(client, tile) {
      const time = now();
      for (const [key, state] of clients) {
        if (time - state.seen < ttlMs) break;
        forget(key);
      }
      let state = clients.get(client);
      if (!state) state = { id: ++sequence, target: { ...tile }, active: true, generation: 0 };
      else if (state.target.z !== tile.z || far(state.target, tile)) { state.target = { ...tile }; state.generation++; }
      state.seen = time;
      clients.delete(client); clients.set(client, state);
      while (clients.size > limit) forget(clients.keys().next().value);
      const live = () => state.active && now() - state.seen < ttlMs;
      const generation = state.generation;
      return {
        current: () => live() && (!reprioritize || state.generation === generation),
        forTile: tile => ({
          key: `${state.id}/${tile.z}/${tile.x}/${tile.y}`,
          live,
          clients: () => live() ? [state.id] : [],
          score: () => {
            if (!live()) return 0;
            if (!reprioritize) return 2;
            if (state.target.z !== tile.z) return 0;
            return far(state.target, tile) ? 1 : 2;
          },
        }),
      };
    },
  };
}
function interestScore(interests, priority = Infinity) {
  let score = 0;
  for (const [key, interest] of interests) {
    if (interest.live && !interest.live()) { interests.delete(key); continue; }
    if ((interest.priority ?? 0) <= priority) score = Math.max(score, interest.score());
  }
  return score;
}
function rememberInterest(interests, interest) {
  interestScore(interests); // Expired/evicted clients must not accumulate on shared jobs.
  interests.set(interest.key, interest);
}
module.exports = { createRequestFocus, interestScore, rememberInterest };
