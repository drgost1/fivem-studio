export interface RuntimeIdentityConfig {
  serverDataWorkspace: string;
  serverConfigPath: string;
  txAdminDataDirectory: string;
  txAdminControlProfile: string;
  rconHost: string;
  rconPort: number;
  rconConfigured: boolean;
}

/**
 * Stable, secret-free contract used by Studio to verify that its workspace is
 * attached to the same runtime the MCP server will control.
 */
export function buildRuntimeIdentity(version: string, config: RuntimeIdentityConfig) {
  return {
    contractVersion: "3",
    mcp: { name: "qb-studio-runtime", version },
    runtime: {
      serverData: {
        workspacePath: config.serverDataWorkspace || null,
        configPath: config.serverConfigPath || null,
      },
      txAdmin: {
        dataDirectory: config.txAdminDataDirectory || null,
        controlProfile: config.txAdminControlProfile || null,
      },
      rcon: {
        host: config.rconHost,
        port: config.rconPort,
        configured: config.rconConfigured,
      },
    },
    capabilities: {
      console: Boolean(config.txAdminDataDirectory && config.txAdminControlProfile),
      resourceLifecycle: config.rconConfigured,
    },
  };
}
