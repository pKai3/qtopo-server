// Readable JSON for both standalone styles and complete live profiles.
// Whitespace changes only: preserve every value, key order and drawing order.
const indent = depth => '  '.repeat(depth);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function inline(value) {
  if (Array.isArray(value)) return value.length ? `[ ${value.map(inline).join(', ')} ]` : '[]';
  if (object(value)) {
    const fields = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`);
    return fields.length ? `{ ${fields.join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

function section(layer) {
  const name = layer['source-layer'] || layer.id || '';
  const families = [
    /^(Mainland|Island|Seas)$/i,
    /contour/i,
    /vegetation|forest|mangrove|national.park|conservation|nature.refuge/i,
    /water|lake|canal|pondage|shoreline|coastline|hydro/i,
    /road|bridge|motorway/i,
    /rail/i,
  ];
  return `${layer.type}:${families.findIndex(pattern => pattern.test(name))}`;
}

function layerRows(layers, depth) {
  if (!layers.length) return '[]';
  // Align short leading fields within each consecutive group. Long expressions
  // remain intact instead of pushing every neighbouring row far to the right.
  const groups = [];
  for (const layer of layers) {
    const last = groups.at(-1);
    if (last && section(last[0]) === section(layer)) last.push(layer);
    else groups.push([layer]);
  }
  let count = 0;
  const rows = groups.map(group => {
    const entries = group.map(layer => Object.entries(layer));
    const widths = [];
    for (let column = 0; ; column++) {
      const key = entries[0][column]?.[0];
      if (!key || entries.some(row => row[column]?.[0] !== key || typeof row[column][1] === 'object')) break;
      const width = Math.max(...entries.map(row => inline(row[column][1]).length));
      if (width > 160) break;
      widths.push(width);
    }
    return entries.map(row => {
      const fields = row.map(([key, value], column) => {
        const text = inline(value);
        const field = `${JSON.stringify(key)}: ${text}`;
        if (column === row.length - 1) return field;
        return field + ',' + ' '.repeat(1 + Math.max(0, (widths[column] || 0) - text.length));
      });
      count++;
      return `${indent(depth + 1)}{ ${fields.join('')} }${count < layers.length ? ',' : ''}`;
    }).join('\n');
  });
  return `[\n${rows.join('\n\n')}\n${indent(depth)}]`;
}

function formatStyleJson(value) {
  function write(item, depth, key) {
    if (key === 'layers' && Array.isArray(item) && item.every(object)) return layerRows(item, depth);
    if (!object(item) || !Object.keys(item).length) return inline(item);
    const fields = Object.entries(item).map(([name, child]) =>
      `${indent(depth + 1)}${JSON.stringify(name)}: ${write(child, depth + 1, name)}`);
    return `{\n${fields.join(',\n')}\n${indent(depth)}}`;
  }
  return write(value, 0) + '\n';
}

module.exports = { formatStyleJson };
