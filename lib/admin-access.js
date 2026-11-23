const { BlockList, isIP } = require('node:net');

function networks(value, name) {
  const list = new BlockList();
  for (const entry of value.split(',').map(v => v.trim()).filter(Boolean)) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address), bits = version === 4 ? 32 : 128;
    if (!version || extra != null || (prefix != null && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > bits))) {
      throw new Error(`${name} must contain explicit IP addresses or CIDR networks; unrestricted networks are not allowed`);
    }
    list.addSubnet(address, prefix == null ? bits : Number(prefix), version === 4 ? 'ipv4' : 'ipv6');
  }
  return address => {
    const version = isIP(address || '');
    return !!version && list.check(address, version === 4 ? 'ipv4' : 'ipv6');
  };
}

function hostname(value) {
  try {
    const url = new URL(`http://${value}`);
    if (!value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.hostname.toLowerCase();
  } catch { return null; }
}

function createAdminAccess(config) {
  const allowed = networks(config.adminAllowedNetworks, 'ADMIN_ALLOWED_NETWORKS');
  const trustProxy = networks(config.trustedProxies, 'TRUSTED_PROXIES');
  const hosts = new Set(config.adminAllowedHosts.split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
  for (const host of hosts) {
    if (host.includes('*') || hostname(host) !== host) throw new Error('ADMIN_ALLOWED_HOSTS must contain exact hostnames or bracketed IPv6 addresses, without ports, URLs or wildcards');
  }
  return {
    trustProxy,
    authorize(req, res, next) {
      res.set('Cache-Control', 'no-store');
      const proxied = trustProxy(req.socket.remoteAddress);
      const forwarded = ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'Forwarded'].some(name => req.get(name));
      // An unconfigured proxy must never turn an Internet request into a
      // trusted LAN request. A configured proxy must identify the client.
      if ((!proxied && forwarded) || (proxied && !req.get('X-Forwarded-For')) || !allowed(req.ip) || !hosts.has(hostname(req.get('host')))) {
        return res.status(403).json({ error: 'Management access is restricted to configured networks and hostnames.' });
      }
      next();
    },
  };
}

function sameOrigin(req) {
  const origin = req.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(`${req.protocol}://${req.get('host')}`).origin; }
  catch { return false; }
}

module.exports = { createAdminAccess, sameOrigin };
