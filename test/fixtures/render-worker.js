const fs = require('node:fs');
process.once('message', job => {
  if (job.hang) return setInterval(() => {}, 1000);
  fs.writeFileSync(job.outPath, Buffer.from('rendered-test-output'));
  process.exit(0);
});
