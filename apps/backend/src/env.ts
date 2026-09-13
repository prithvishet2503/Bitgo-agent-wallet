import * as dotenv from 'dotenv';

// Must be imported (and therefore executed) before anything that reads
// process.env at module-load time - notably chainExecutor.ts, which decides
// mock vs. real mode the instant it's imported. Import this as the very first
// line of index.ts so ES module evaluation order guarantees it runs first.
dotenv.config();
