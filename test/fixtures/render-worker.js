const fs = require('node:fs');
process.on('message', async job => {
  if (job.hang) return setInterval(() => {}, 1000);
  if (job.fail) return process.send({ error: 'fixture failure' });
  if (job.recordPid) fs.writeFileSync(job.recordPid, String(process.pid));
  while (job.gate && !fs.existsSync(job.gate)) await new Promise(resolve => setTimeout(resolve, 5));
  fs.writeFileSync(job.outPath, Buffer.from('rendered-test-output'));
  process.send({ done: true });
});
