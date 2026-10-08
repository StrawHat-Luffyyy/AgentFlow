#!/usr/bin/env node
// Runs the TypeScript sources through tsx until the CLI gains a bundled build.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
