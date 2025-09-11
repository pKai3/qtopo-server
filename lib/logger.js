// lib/logger.js
const util = require("util");

// ANSI colors
const ANSI = {
  reset:  "\x1b[0m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
};

// Level → color
const LEVEL_COLOR = {
  LOG: "",           // no color
  WRN: ANSI.yellow,
  ERR: ANSI.red,
  SYS: ANSI.cyan,
};

// Target tag width for aligning the *message start* by padding AFTER the colon
const TAG_TARGET_WIDTH = 10; // tweak if you want messages to start later/earlier

function ts() {
  return new Date().toISOString(); // UTC
}

function formatLine(level, tag, msg) {
  const color = LEVEL_COLOR[level] || "";
  const reset = color ? ANSI.reset : "";
  const t = typeof tag === "string" && tag.length ? tag : "";
  const padCount = Math.max(0, TAG_TARGET_WIDTH - t.length);
  const postColonPad = " ".repeat(padCount) + " "; // one extra space before the message
  return `${color}[${level}]${reset} [${ts()}] [${t}]:${postColonPad}${msg}`;
}

function write(out, level, tag, args) {
  // Support L.sys(message) style (no tag), default tag "SYS"
  let message, tagOut = tag;
  if (args === undefined) {
    message = util.format(tagOut);   // tag param actually holds the message
    tagOut = "SYS";
  } else {
    message = util.format(...args);
  }
  out.write(formatLine(level, tagOut, message) + "\n");
}

module.exports = {
  log(tag, ...args)  { write(process.stdout, "LOG", tag, args); },
  warn(tag, ...args) { write(process.stdout, "WRN", tag, args); },
  err(tag, ...args)  { write(process.stderr, "ERR", tag, args); },
  sys(msg)           { write(process.stdout, "SYS", msg); }, // message only
};