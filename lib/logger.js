// lib/logger.js
const COLORS = {
  reset: "\x1b[0m",
  red:   "\x1b[31m",
  yellow:"\x1b[33m",
  cyan:  "\x1b[36m",
};

const ts = () => new Date().toISOString();

function out(level, tag, msg, color) {
  const line = `[${level}] [${ts()}] [${tag}]: ${msg}`;
  if (level === "ERR") {
    console.error((color ?? "") + line + COLORS.reset);
  } else {
    console.log((color ?? "") + line + COLORS.reset);
  }
}

module.exports = {
  log:  (tag, msg) => out("LOG", tag, msg),
  warn: (tag, msg) => out("WRN", tag, msg, COLORS.yellow),
  err:  (tag, msg) => out("ERR", tag, msg, COLORS.red),
  sys:  (msg)      => out("LOG", "SYS", msg, COLORS.cyan),
};