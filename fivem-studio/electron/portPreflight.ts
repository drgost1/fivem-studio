import dgram from "node:dgram";
import net from "node:net";

function checkTcp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

function checkUdp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    socket.unref();
    socket.once("error", (error) => {
      try { socket.close(); } catch { /* bind failed before the socket became active */ }
      reject(error);
    });
    socket.bind({ address: host, port, exclusive: true }, () => {
      socket.close(resolve);
    });
  });
}

/** Briefly reserves both transports before launch so a clear error replaces a failed FXServer boot. */
export async function assertFxServerPortAvailable(host: string, port: number): Promise<void> {
  try {
    await checkTcp(host, port);
    await checkUdp(host, port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      throw new Error(`FXServer endpoint ${host}:${port} is already in use or unavailable. Stop the process holding port ${port}, then try again.`);
    }
    throw new Error(`Could not verify FXServer endpoint ${host}:${port}: ${(error as Error).message}`);
  }
}
