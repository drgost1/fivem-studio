/**
 * FXServer RCON client.
 *
 * FiveM's RCON is NOT the Source TCP RCON protocol — it's the older
 * Quake3-style UDP RCON that FXServer inherited from the CitizenFX/GTA:N
 * lineage:
 *
 *   request:  0xFFFFFFFF + "rcon " + <password> + " " + <command>
 *   response: one or more UDP packets, each prefixed 0xFFFFFFFF + "print\n"
 *             followed by the command's console output as text.
 *
 * There's no handshake/challenge step for FXServer's implementation, and no
 * guarantee the whole response arrives in a single packet for chatty
 * commands, so we collect packets for a short quiet-window before resolving.
 */

import dgram from "node:dgram";

const PACKET_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const PRINT_PREFIX = "print\n";
const MAX_COMMAND_BYTES = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Milliseconds of silence after the last packet before we consider the response complete. */
  quietWindowMs?: number;
  /** Overall timeout if the server never responds at all. */
  timeoutMs?: number;
}

export class RconError extends Error {}

export class RconClient {
  private host: string;
  private port: number;
  private password: string;
  private quietWindowMs: number;
  private timeoutMs: number;

  constructor(opts: RconOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.password = opts.password;
    this.quietWindowMs = opts.quietWindowMs ?? 150;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** Sends a single console command via RCON and returns the concatenated console output. */
  async command(cmd: string): Promise<string> {
    if (!this.password || this.password === "changeme") {
      throw new RconError(
        "RCON_PASSWORD is not configured (still 'changeme' or empty). Set it to match rcon_password in server.cfg.",
      );
    }
    if (Buffer.byteLength(cmd, "utf8") > MAX_COMMAND_BYTES) {
      throw new RconError(`RCON command exceeds the ${MAX_COMMAND_BYTES}-byte local development limit.`);
    }

    const payload = Buffer.concat([
      PACKET_PREFIX,
      Buffer.from(`rcon ${this.password} ${cmd}`, "utf8"),
    ]);

    return new Promise<string>((resolve, reject) => {
      const socket = dgram.createSocket(this.host.includes(":") ? "udp6" : "udp4");
      const chunks: string[] = [];
      let responseBytes = 0;
      let quietTimer: NodeJS.Timeout | null = null;
      let overallTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        if (quietTimer) clearTimeout(quietTimer);
        if (overallTimer) clearTimeout(overallTimer);
        socket.close();
      };

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(chunks.join(""));
      };

      const armQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), this.quietWindowMs);
      };

      socket.on("error", (err) => finish(err));

      socket.on("message", (msg, remote) => {
        const source = remote.address.toLowerCase();
        const isLoopback = source === "::1" || source === "127.0.0.1" || source.startsWith("127.");
        if (!isLoopback || remote.port !== this.port) return;
        responseBytes += msg.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          finish(new RconError(`RCON response exceeds the ${MAX_RESPONSE_BYTES}-byte local development limit.`));
          return;
        }
        let text = msg.toString("utf8");
        if (msg.subarray(0, 4).equals(PACKET_PREFIX)) {
          text = msg.subarray(4).toString("utf8");
        }
        if (text.startsWith(PRINT_PREFIX)) {
          text = text.slice(PRINT_PREFIX.length);
        }
        chunks.push(text);
        armQuietTimer();
      });

      overallTimer = setTimeout(() => {
        if (chunks.length === 0) {
          finish(
            new RconError(
              `No RCON response from ${this.host}:${this.port} within ${this.timeoutMs}ms. ` +
                `Check RCON_HOST/RCON_PORT/RCON_PASSWORD and that rcon_password is set in server.cfg.`,
            ),
          );
        } else {
          finish();
        }
      }, this.timeoutMs);

      socket.send(payload, this.port, this.host, (err) => {
        if (err) finish(err);
      });
    });
  }
}
