const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPublicAddressSet,
  assertPublicUrlTarget,
  fetchUrlContent,
  isPublicIpAddress,
  resolvePublicRedirectUrl,
} = require('../dist/main/fetchService');

test('accepts public IPv4 and IPv6 addresses', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2001:4860:4860::8888'), true);
});

test('rejects non-public IPv4 address ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '192.0.2.1',
    '224.0.0.1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test('rejects non-public IPv6 and mapped IPv4 addresses', () => {
  for (const address of ['::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test('rejects a hostname when any resolved address is non-public', () => {
  assert.throws(
    () => assertPublicAddressSet('mixed.example', ['93.184.216.34', '127.0.0.1']),
    /non-public network address/,
  );
});

test('rejects credentials and direct private-network URLs', () => {
  assert.throws(
    () => assertPublicUrlTarget(new URL('https://user:secret@example.com')),
    /credentials embedded/,
  );
  assert.throws(
    () => assertPublicUrlTarget(new URL('http://127.0.0.1:8080/admin')),
    /non-public network addresses/,
  );
  assert.throws(
    () => assertPublicUrlTarget(new URL('http://[::1]/admin')),
    /non-public network addresses/,
  );
});

test('validates every redirect target before following it', () => {
  assert.equal(
    resolvePublicRedirectUrl('https://example.com/start', '/next'),
    'https://example.com/next',
  );
  assert.throws(
    () => resolvePublicRedirectUrl('https://example.com/start', 'http://169.254.169.254/latest/meta-data'),
    /non-public network addresses/,
  );
  assert.throws(
    () => resolvePublicRedirectUrl('https://example.com/start', 'file:///etc/passwd'),
    /only supports http and https/,
  );
});

test('blocks localhost after DNS resolution before making a request', async () => {
  const result = await fetchUrlContent({ url: 'http://localhost:65535/private' });
  assert.equal(result.success, false);
  assert.match(result.error, /non-public network address/);
});
