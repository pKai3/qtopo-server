const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminAccess } = require('../lib/admin-access');
const { loadConfig } = require('../lib/config');

test('management configuration fails closed on malformed or unrestricted networks and hostnames', () => {
  assert.equal(loadConfig({}).adminAllowedNetworks, '');
  for (const value of ['*', 'private', '0.0.0.0/0', '::/0', '127.0.0.1/33', '127.0.0.1/32/extra', '192.168.0.1/nope']) {
    for (const name of ['ADMIN_ALLOWED_NETWORKS', 'TRUSTED_PROXIES']) {
      assert.throws(() => createAdminAccess(loadConfig({ [name]: value })), new RegExp(name));
    }
  }
  for (const value of ['*', '*.example.test', 'http://tower.local', 'tower.local:9877', 'user@tower.local']) {
    assert.throws(() => createAdminAccess(loadConfig({ ADMIN_ALLOWED_HOSTS: value })), /ADMIN_ALLOWED_HOSTS/);
  }
});

test('trusted proxy addresses handle IPv4-mapped IPv6 without trusting unrelated peers', () => {
  const { trustProxy } = createAdminAccess(loadConfig({ TRUSTED_PROXIES: '192.0.2.10/32,2001:db8::10/128' }));
  for (const address of ['192.0.2.10', '::ffff:192.0.2.10', '::ffff:c000:20a', '2001:db8::10']) assert.equal(trustProxy(address), true, address);
  for (const address of ['192.0.2.11', '2001:db8::11', 'invalid', undefined]) assert.equal(trustProxy(address), false, address);
});
