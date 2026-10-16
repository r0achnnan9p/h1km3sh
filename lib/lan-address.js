import os from 'os';

// docker0/br-xxxx/veth 等容器网桥与 VPN 隧道口的地址访问不到，别混进来
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|utun|tun|tap|awdl|llw|tailscale|zt)/i;

export function getLanAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL_IFACE.test(name))
    .flatMap(([, nets]) => nets || [])
    .filter((net) => net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}
