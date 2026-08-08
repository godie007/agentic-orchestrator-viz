import net from 'node:net';
const sock = process.env.ORQ_SOCKET;
const s = net.createConnection({ path: sock });
s.on('connect', () => {
  process.stdin.on('data', (d) => s.write(d));
  s.on('data', (d) => process.stdout.write(d));
  s.on('close', () => process.exit(0));
  process.stdin.on('end', () => s.end());
});
s.on('error', (e) => { console.error('relay sock', e.message); process.exit(1); });
