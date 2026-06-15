const containsTexCommand = (value: string): boolean => /\\[a-zA-Z]+/.test(value);

const containsMathOperator = (value: string): boolean => (
  /[A-Za-z0-9)\]}]\s*(?:[=+\-*/^_<>]|<=|>=|!=)\s*[A-Za-z0-9([{]/.test(value)
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
