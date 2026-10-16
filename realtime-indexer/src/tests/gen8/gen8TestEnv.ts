// Imported first by unit tests that load the gen-8 ingest modules (their import graph reaches env.ts): a local,
// never-connected database URL and no Ably, as src/tests/dogeosNativeUsdOracle.test.ts does. No query reaches it.
process.env.RUNTIME_ENVIRONMENT = process.env.RUNTIME_ENVIRONMENT || "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/memewarzone_gen8_unit";
process.env.DB_WATCHDOG_EXIT = "0";
export {};
