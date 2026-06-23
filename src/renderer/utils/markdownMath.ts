const containsTexCommand = (value: string): boolean => /\\[a-zA-Z]+/.test(value);

const containsProseWord = (value: string): boolean => /\b[A-Za-z]{2,}\b/.test(
  value.replace(/\\[a-zA-Z]+/g, ''),
);

const containsMathOperator = (value: string): boolean => (
  !containsProseWord(value)
  && /[A-Za-z0-9)\]}]\s*(?:[=+\-*/^_<>]|<=|>=|!=)\s*[A-Za-z0-9([{]/.test(value)
);

const isLikelyMath = (value: string): boolean => {
  const excerpt = value.trim();

  if (!excerpt) return false;

  return (
    containsTexCommand(excerpt)
    || containsMathOperator(excerpt)
    || /^[A-Za-z](?:[A-Za-z0-9]*|\([^)]*\))$/.test(excerpt)
  );
};

const isEscaped = (value: string, index: number): boolean => {
  let backslashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
};

const isCurrencyDollarSign = (value: string, index: number): boolean => {
  if (value[index] !== '$' || value[index + 1] === '$') {
    return false;
  }

  const remaining = value.slice(index + 1);
  const match = /^\d[\d,]*(?:\.\d+)?/.exec(remaining);

  if (!match) {
    return false;
  }

  const nextCharacter = remaining[match[0].length] ?? '';
  const hasCurrencyFormatting = /[,.]/.test(match[0]);

  if (/\s/.test(nextCharacter)) {
    const nextNonWhitespace = remaining.slice(match[0].length).trimStart()[0] ?? '';

    if (!hasCurrencyFormatting && /^[=+\-*/^_<>]$/.test(nextNonWhitespace)) {
      return false;
    }
  }

  const currencyBoundaryCharacters = new Set([')', '/', '.', '%', '*', '_', '~', ']', ',']);

  return (
    nextCharacter === ''
    || /\s/.test(nextCharacter)
    || /[A-Za-z]/.test(nextCharacter)
    || currencyBoundaryCharacters.has(nextCharacter)
    || nextCharacter === '-'
    || nextCharacter === '–'
    || nextCharacter === '—'
  );
};

const protectNonMathDollarSigns = (value: string): string => {
  const dollarIndexes: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (
      value[index] === '$'
      && value[index - 1] !== '$'
      && value[index + 1] !== '$'
      && !isEscaped(value, index)
    ) {
      dollarIndexes.push(index);
    }
  }

  if (dollarIndexes.length === 0) return value;

  const mathDollarIndexes = new Set<number>();

  for (let index = 0; index < dollarIndexes.length - 1; index += 1) {
    const openingIndex = dollarIndexes[index];
    const closingIndex = dollarIndexes[index + 1];

    if (isCurrencyDollarSign(value, openingIndex) || isCurrencyDollarSign(value, closingIndex)) {
      continue;
    }

    if (isLikelyMath(value.slice(openingIndex + 1, closingIndex))) {
      mathDollarIndexes.add(openingIndex);
      mathDollarIndexes.add(closingIndex);
      index += 1;
    }
  }

  const protectedDollarIndexes = new Set(
    dollarIndexes.filter((index) => !mathDollarIndexes.has(index)),
  );

  return value.split('')
    .map((character, index) => (
      protectedDollarIndexes.has(index) ? `\\${character}` : character
    ))
    .join('');
};

const protectTextOutsideCode = (value: string): string => {
  const codePattern = /(`{1,3})([\s\S]*?)\1/g;
  let result = '';
  let lastIndex = 0;

  for (const match of value.matchAll(codePattern)) {
    const matchIndex = match.index ?? 0;
    result += protectNonMathDollarSigns(value.slice(lastIndex, matchIndex));
    result += match[0];
    lastIndex = matchIndex + match[0].length;
  }

  return result + protectNonMathDollarSigns(value.slice(lastIndex));
};

export const prepareMarkdownMath = (value: string): string => (
  protectTextOutsideCode(
    value
      .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, math) => `$$${math.trim()}$$`)
      .split('\n')
      .map((line) => {
        const match = /^(\s*)\[\s*(.+?)\s*\](\s*)$/.exec(line);

        if (!match || !containsTexCommand(match[2])) {
          return line;
        }

        return `${match[1]}$$${match[2]}$$${match[3]}`;
      })
      .join('\n'),
  )
);
