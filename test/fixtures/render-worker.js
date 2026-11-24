const fs = require('node:fs');
process.on('message', async job => {
  if (job.promote) return;
  if (job.crash) return process.stdout.write('native fixture output\n', () => {
    process.stderr.write('native fixture fatal without newline', () => process.exit(7));
  });
  if (job.hang) return setInterval(() => {}, 1000);
  if (job.fail) return process.send({ error: 'fixture failure' });
  if (job.recordPid) fs.writeFileSync(job.recordPid, String(process.pid));
  if (job.assertExitedPidFile) {
    try {
      process.kill(Number(fs.readFileSync(job.assertExitedPidFile, 'utf8')), 0);
      return process.send({ error: 'replacement started before previous worker exited' });
    } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  if (job.fetchUrls) {
    try {
      await Promise.all(job.fetchUrls.map(async url => {
        const response = await fetch(url, { headers: { 'X-QTopo-Render': job.resourceOwner, 'X-QTopo-Priority': String(job.priority) } });
        if (!response.ok) throw new Error('Resource failed: ' + response.status);
        await response.arrayBuffer();
      }));
    } catch (error) { return process.send({ error: error.message }); }
  }
  while (job.gate && !fs.existsSync(job.gate)) await new Promise(resolve => setTimeout(resolve, 5));
  for (const tile of job.outputs || [job]) {
    fs.mkdirSync(require('node:path').dirname(tile.outPath), { recursive: true });
    fs.writeFileSync(tile.outPath, Buffer.from('rendered-test-output'));
    if (job.outputs) process.send({ tileReady: tile.outPath });
    if (job.failAfterFirst) return process.send({ error: 'fixture partial failure' });
    while (job.encodeGate && !fs.existsSync(job.encodeGate)) await new Promise(resolve => setTimeout(resolve, 5));
  }
  process.send({ done: true, timings: job.timings, rssBytes: job.rssBytes });
});
