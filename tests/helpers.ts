// Shared test bootstrap: isolate env BEFORE any src module (dotenv runs on first import of src/config).
export function isolateEnv(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    NODE_ENV: "test",
    CHAIN: "testnet",
    DATABASE_PATH: ":memory:",
    GUARD_ADDRESS_TESTNET: "",
    POOL_ADDRESS_TESTNET: "",
    KEEPER_PRIVATE_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_BOT_USERNAME: "",
    ANTHROPIC_API_KEY: "",
    OPENROUTER_API_KEY: "",
    QUICKNODE_WEBHOOK_SECURITY_TOKEN: "",
    SENTINEL_ENABLED: "false",
    PUBLIC_BASE_URL: "",
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) process.env[k] = v;
}
