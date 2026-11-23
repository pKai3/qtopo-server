// Native addons write outside our JavaScript logger. Keep complete lines when
// possible, but bound unterminated output and flush the final crash message.
function forwardWorkerOutput(stream, write) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    while (pending.length) {
      const newline = pending.indexOf('\n');
      if (newline >= 0 && newline <= 8192) {
        write(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      } else if (pending.length > 8192) {
        write(pending.slice(0, 8192)); pending = pending.slice(8192);
      } else break;
    }
  });
  stream.on('end', () => { if (pending) write(pending); pending = ''; });
}
module.exports = { forwardWorkerOutput };
