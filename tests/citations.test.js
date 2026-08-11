const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCodexCitations } = require('../dist/shared/citations');

const groups = [
  {
    id: 'search-1',
    query: 'first',
    searchedAt: '2026-08-10T00:00:00.000Z',
    sources: [
      { title: 'Alpha', url: 'https://example.com/alpha', domain: 'example.com' },
      { title: 'Beta', url: 'https://example.com/beta', domain: 'example.com' },
    ],
  },
  {
    id: 'search-2',
    query: 'second',
    searchedAt: '2026-08-10T00:01:00.000Z',
    sources: [
      { title: 'Gamma', url: 'https://example.org/gamma', domain: 'example.org' },
      { title: 'Alpha duplicate', url: 'https://example.com/alpha', domain: 'example.com' },
    ],
  },
];

test('renders Codex citation markers as numbered Markdown source links', () => {
  assert.equal(
    renderCodexCitations(
      'Claim. citeturn0search0turn1search0',
      groups,
    ),
    'Claim. [1](<https://example.com/alpha>) [3](<https://example.org/gamma>)',
  );
});

test('uses the existing source number for duplicate URLs', () => {
  assert.equal(
    renderCodexCitations('Claim. citeturn1search1', groups),
    'Claim. [1](<https://example.com/alpha>)',
  );
});

test('removes unresolved private citation markers', () => {
  assert.equal(
    renderCodexCitations('Claim. citeturn9search9', groups),
    'Claim.',
  );
  assert.equal(
    renderCodexCitations('Claim. citeturn0search0'),
    'Claim.',
  );
});

test('leaves ordinary Markdown links unchanged', () => {
  const markdown = 'See [the source](https://example.com).';
  assert.equal(renderCodexCitations(markdown, groups), markdown);
});
