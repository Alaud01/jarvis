const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCorrectionPair,
  extractCorrectionCandidate,
  isSimilarCorrection,
  nextLearnedStatus,
} = require('../dist/shared/correctionLearning');
const { createMultipartUpload } = require('../dist/main/pythonService');

test('extracts a compact correction inside the inserted span', () => {
  assert.deepEqual(
    extractCorrectionCandidate('Hello jar viss today', 'Hello Jarvis today', 6, 14),
    { alias: 'jar viss', preferred: 'Jarvis' },
  );
});

test('ignores unrelated typing after the inserted span', () => {
  assert.equal(
    extractCorrectionCandidate('Hello Jarvis', 'Hello Jarvis and welcome', 6, 12),
    null,
  );
});

test('ignores punctuation-only changes and pure deletions', () => {
  assert.equal(extractCorrectionCandidate('Hello.', 'Hello!', 0, 6), null);
  assert.equal(extractCorrectionCandidate('Hello extra', 'Hello ', 6, 11), null);
});

test('recognizes spelling-like corrections despite case, spacing, and transpositions', () => {
  assert.equal(isSimilarCorrection('jar viss', 'Jarvis'), true);
  assert.equal(isSimilarCorrection('teh', 'the'), true);
  assert.equal(isSimilarCorrection('their', 'there'), true);
});

test('ignores clear rewording inside the inserted span', () => {
  assert.equal(isSimilarCorrection('can you send it', 'please forward that'), false);
  assert.equal(
    extractCorrectionCandidate('Maybe can you send it today', 'Maybe please forward that today', 6, 21),
    null,
  );
});

test('promotes recurring corrections while preserving disabled state', () => {
  assert.equal(nextLearnedStatus('learning', 1), 'learning');
  assert.equal(nextLearnedStatus('learning', 2), 'active');
  assert.equal(nextLearnedStatus('disabled', 3), 'disabled');
});

test('classifies proper nouns as vocabulary while flagging common-word sources', () => {
  assert.deepEqual(
    classifyCorrectionPair('cloud', 'Claude'),
    {
      decision: 'eligible',
      reasons: ['source_is_common_word', 'eligible_proper_noun'],
    },
  );
});

test('classifies sentence rewrites as ineligible for automatic learning', () => {
  assert.deepEqual(
    classifyCorrectionPair('can you send it', 'please forward that'),
    {
      decision: 'ineligible',
      reasons: ['ineligible_sentence_rewrite'],
    },
  );
});

test('multipart process-flow upload includes dictionary voice context', async () => {
  const context = {
    app: { name: 'Mail', bundleId: 'com.apple.mail', pid: 42 },
    destination: 'generic',
    field: null,
    accessibilityStatus: 'captured',
    dictionary: [{ id: 'rule-1', preferred: 'Jarvis', aliases: ['jar viss'], scope: { kind: 'global' } }],
    vocabulary: [{ id: 'vocab-1', text: 'Jarvis', pinned: true }],
  };
  const upload = createMultipartUpload(Buffer.from('wav'), context);
  const chunks = [];
  for await (const chunk of upload.body) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');

  assert.match(body, /name="context"/);
  assert.match(body, /"preferred":"Jarvis"/);
  assert.match(body, /"text":"Jarvis"/);
  assert.match(body, /"bundleId":"com\.apple\.mail"/);
  assert.equal(Buffer.byteLength(body), upload.contentLength);
});
