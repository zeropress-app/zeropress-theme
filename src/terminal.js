const UNSAFE_TERMINAL_CHARACTER_REGEX = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

export function toTerminalSafeText(value) {
  return String(value ?? '').replace(UNSAFE_TERMINAL_CHARACTER_REGEX, (character) => (
    `\\u${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  ));
}

export function toTerminalSafeMultilineText(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => toTerminalSafeText(line))
    .join('\n');
}
