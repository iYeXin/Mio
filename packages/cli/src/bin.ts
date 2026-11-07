#!/usr/bin/env node
import { main } from "./index.js";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack && process.env.MIO_DEBUG) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
