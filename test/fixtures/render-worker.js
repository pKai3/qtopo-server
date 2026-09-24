const fs = require('node:fs');
process.on('message', job => {
  if (job.hang) return setInterval(() => {}, 1000);
  if (job.fail) return process.send({ error: 'fixture failure' });
  if (job.recordPid) fs.writeFileSync(job.recordPid, String(process.pid));
  fs.writeFileSync(job.outPath, Buffer.from('rendered-test-output'));
  process.send({ done: true });
});
