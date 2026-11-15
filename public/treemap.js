// Squarified treemap layout (Bruls, Huizing and van Wijk): boxes whose areas
// match the sizes, kept as close to square as possible. No DOM.

function worst(row, side, scale) {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const v of row) {
    const a = v * scale;
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Lays out `items` (each with a numeric `size`, biggest first is best) in the
 * rectangle { x, y, w, h }. Returns [{ item, x, y, w, h }]; items of size 0
 * are left out.
 */
export function squarify(items, rect) {
  const list = items.filter((it) => it.size > 0).sort((a, b) => b.size - a.size);
  const out = [];
  const total = list.reduce((s, it) => s + it.size, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < list.length) {
    const side = Math.min(w, h);
    const row = [list[i].size];
    let j = i + 1;
    while (j < list.length) {
      const next = [...row, list[j].size];
      if (worst(next, side, scale) > worst(row, side, scale)) break;
      row.push(list[j].size);
      j++;
    }
    const rowArea = row.reduce((s, v) => s + v, 0) * scale;
    if (w >= h) {
      // A column on the left.
      const cw = rowArea / h;
      let cy = y;
      for (let k = i; k < j; k++) {
        const ch = (list[k].size * scale) / cw;
        out.push({ item: list[k], x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      // A row along the top.
      const rh = rowArea / w;
      let cx = x;
      for (let k = i; k < j; k++) {
        const cw = (list[k].size * scale) / rh;
        out.push({ item: list[k], x: cx, y, w: cw, h: rh });
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}
