export function createColor(stream) {
  const enabled = colorsEnabled(stream);
  const wrap = (code, value) => (enabled ? `\x1b[${code}m${value}\x1b[0m` : value);
  return {
    red: (value) => wrap('31', value),
    yellow: (value) => wrap('33', value),
    blue: (value) => wrap('34', value),
    green: (value) => wrap('32', value),
    bold: (value) => wrap('1', value),
  };
}

function colorsEnabled(stream) {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(stream?.isTTY);
}
