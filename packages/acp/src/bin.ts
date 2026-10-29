#!/usr/bin/env bun
import { applyElizaAcpProfileEnv, runElizaAcpServer } from "./index.ts";

applyElizaAcpProfileEnv();
await runElizaAcpServer();
