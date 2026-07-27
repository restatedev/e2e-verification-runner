# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/claude-code) when working with this repository.

## Project Overview

This is the **E2E Verification Runner** for [Restate](https://restate.dev/), a TypeScript/Node.js project that runs end-to-end verification tests. It uses an interpreter-based testing framework to validate Restate services.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Build the TypeScript project
npm run build

# Run linting
npm run lint

# Format code
npm run format

# Run as webapp
SERVICES=InterpreterDriver node dist/app.js

# Run as standalone job
SERVICES=InterpreterDriverJob node dist/app.js
```

## Architecture

- **Entry point**: `src/app.ts` - Routes to interpreter driver based on `SERVICES` env var
- **Core interpreter**: `src/interpreter/` - Contains the test generation and execution logic
  - `entry_point.ts` - Exports `interpreterDriver` and `interpreterDriverJob`
  - `test_generator.ts` - Generates test cases
  - `test_driver.ts` - Drives test execution
  - `interpreter.ts` - Core interpreter logic
  - `commands.ts` - Command definitions
  - `infra.ts` - Infrastructure utilities
  - `raw_client.ts` - Raw client implementation

## Key Dependencies

- `@restatedev/restate-sdk-clients` - Restate SDK client library
- `testcontainers` - For running containerized tests

## Scripts Directory

The `scripts/` directory contains various test scenarios:
- `run-verification.sh` - Main verification script
- `run-verification-nodocker.sh` - Tests without Docker
- Subdirectories for specific test types: `correctness/`, `compatibility/`, `perf/`, `snapshotting/`, `vqueues/`, `s3metastore/`

## TypeScript Configuration

- Target: ESNext
- Module: Node16
- Strict mode enabled
- Output directory: `./dist`
