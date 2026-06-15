const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCorrectionCandidate, nextLearnedStatus } = require('../dist/shared/correctionLearning');
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

test('promotes recurring corrections while preserving disabled state', () => {
  assert.equal(nextLearnedStatus('learning', 1), 'learning');
  assert.equal(nextLearnedStatus('learning', 2), 'active');
  assert.equal(nextLearnedStatus('disabled', 3), 'disabled');
});

test('multipart process-flow upload includes dictionary voice context', async () => {
  const context = {
    app: { name: 'Mail', bundleId: 'com.apple.mail', pid: 42 },
    destination: 'email',
    field: null,
    accessibilityStatus: 'captured',
    dictionary: [{ preferred: 'Jarvis', aliases: ['jar viss'] }],
  };
  const upload = createMultipartUpload(Buffer.from('wav'), context);
  const chunks = [];
  for await (const chunk of upload.body) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');

  assert.match(body, /name="context"/);
  assert.match(body, /"preferred":"Jarvis"/);
  assert.match(body, /"bundleId":"com\.apple\.mail"/);
  assert.equal(Buffer.byteLength(body), upload.contentLength);
});
