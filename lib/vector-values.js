// Esri sometimes encodes a null attribute as an empty MVT Value message.
// Strict browser decoders reject the whole tile. QLD's empty symbol/label
// classifiers represent class zero (the same features use explicit zero in
// parent tiles). Restore that default; omit other null attributes. Geometry,
// IDs and every valid value are copied unchanged.
function varint(buffer, cursor) {
  let value = 0, scale = 1;
  for (let i = 0; i < 10; i++) {
    if (cursor.pos >= buffer.length) throw new Error('Truncated vector tile');
    const byte = buffer[cursor.pos++];
    value += (byte & 127) * scale;
    if (!(byte & 128)) return value;
    scale *= 128;
  }
  throw new Error('Invalid vector tile varint');
}
function encode(value) {
  const bytes = [];
  do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function fields(buffer) {
  const result = [], cursor = { pos: 0 };
  while (cursor.pos < buffer.length) {
    const start = cursor.pos, key = varint(buffer, cursor), wire = key % 8;
    let bodyStart = cursor.pos, end;
    if (!Number.isSafeInteger(key) || key < 8) throw new Error('Invalid vector tile field');
    if (wire === 0) { varint(buffer, cursor); end = cursor.pos; }
    else if (wire === 1) end = cursor.pos + 8;
    else if (wire === 5) end = cursor.pos + 4;
    else if (wire === 2) { const length = varint(buffer, cursor); bodyStart = cursor.pos; end = bodyStart + length; }
    else throw new Error('Unsupported vector tile wire type');
    if (!Number.isSafeInteger(end) || end > buffer.length) throw new Error('Truncated vector tile field');
    result.push({ key, body: buffer.subarray(bodyStart, end), raw: buffer.subarray(start, end) });
    cursor.pos = end;
  }
  return result;
}
const message = (key, body) => Buffer.concat([encode(key), encode(body.length), body]);
function feature(buffer, indexes, keys, zeroIndex) {
  return Buffer.concat(fields(buffer).map(field => {
    if (field.key !== 18) return field.raw; // packed key/value dictionary pairs
    const cursor = { pos: 0 }, tags = [];
    while (cursor.pos < field.body.length) {
      const key = varint(field.body, cursor), value = varint(field.body, cursor);
      if (!Number.isSafeInteger(value) || value >= indexes.length) throw new Error('Invalid vector tile value index');
      const mapped = indexes[value] === -1 && /^_(symbol|label_class\d*)$/.test(keys[key]) ? zeroIndex : indexes[value];
      if (mapped !== -1) tags.push(encode(key), encode(mapped));
    }
    return message(field.key, Buffer.concat(tags));
  }));
}
function layer(buffer) {
  const entries = fields(buffer), indexes = [], keys = entries.filter(field => field.key === 26).map(field => field.body.toString('utf8'));
  let kept = 0;
  for (const field of entries) if (field.key === 34) indexes.push(field.body.length ? kept++ : -1);
  if (kept === indexes.length) return buffer;
  return Buffer.concat(entries.map(field => {
    if (field.key === 34 && !field.body.length) return Buffer.alloc(0);
    if (field.key === 18) return message(field.key, feature(field.body, indexes, keys, kept));
    return field.raw;
  }).concat(message(34, Buffer.from([32, 0])))); // valid int_value zero
}
function normalizeVectorValues(buffer) {
  let changed = false;
  const output = fields(buffer).map(field => {
    if (field.key !== 26) return field.raw;
    const normalized = layer(field.body);
    if (normalized === field.body) return field.raw;
    changed = true;
    return message(field.key, normalized);
  });
  return changed ? Buffer.concat(output) : buffer;
}
module.exports = { normalizeVectorValues };
