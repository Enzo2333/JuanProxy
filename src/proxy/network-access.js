import { networkInterfaces } from 'node:os';

const VIRTUAL_INTERFACE_PATTERN = /docker|hyper-v|loopback|tap|tun|virtual|vmware|vpn|vethernet|wsl/i;

export function buildProxyAccessUrls({
  port,
  allowLanAccess,
  interfaces = networkInterfaces()
}) {
  const loopbackUrl = buildProxyUrl('127.0.0.1', port);
  if (!allowLanAccess) {
    return [loopbackUrl];
  }

  const candidates = [];
  for (const [interfaceName, addresses] of Object.entries(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      if (!isUsablePrivateIpv4(address)) {
        continue;
      }
      candidates.push({
        address: address.address,
        interfaceName,
        virtual: VIRTUAL_INTERFACE_PATTERN.test(interfaceName)
      });
    }
  }

  candidates.sort((left, right) =>
    Number(left.virtual) - Number(right.virtual) ||
    left.interfaceName.localeCompare(right.interfaceName) ||
    left.address.localeCompare(right.address)
  );

  const urls = candidates.map(({ address }) => buildProxyUrl(address, port));
  return [...new Set([...urls, loopbackUrl])];
}

function isUsablePrivateIpv4(entry) {
  if (!entry || entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) {
    return false;
  }
  const parts = String(entry.address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function buildProxyUrl(host, port) {
  return `http://${host}:${port}/v1`;
}
