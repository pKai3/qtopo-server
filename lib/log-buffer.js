const { randomUUID } = require('node:crypto');
function createLogBuffer(limit = 500) {
  const session = randomUUID(), entries = [];
  let next = 0;
  return {
    append(line) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
      entries.push({ id: ++next, line: plain.length > 8192 ? plain.slice(0, 8192) + '… [truncated]' : plain });
      if (entries.length > limit) entries.shift();
    },
    read(after = 0, previousSession) {
      const reset = !!previousSession && previousSession !== session || after > next;
      const cursor = reset ? 0 : after;
      const truncated = cursor > 0 && entries.length > 0 && cursor < entries[0].id - 1;
      return { session, next, limit, reset, truncated, entries: entries.filter(entry => entry.id > cursor) };
    },
  };
}
module.exports = { createLogBuffer };
