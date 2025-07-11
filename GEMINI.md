# Gemini Project Guidelines

This document provides a set of guidelines for the Gemini AI to follow when working on this project.

## Project Overview

This project, `server-control-s3`, is a tool for updating Amazon AWS instances from S3 packages.

## Project Structure

-   **Source Code:** `src/`
-   **Build Output:** `dist/` (Do not edit manually)
-   **Examples:** `example/`
-   **Tests:** `test/`

## Development Workflow

### Package Manager

-   Use `npm` for all package management.

### Formatting

-   Run `npm run pretty` to format the code before committing. This command executes `prettier --write "src/*.js" "example/*.js" "test/*.ts"`.

### Linting

-   Run `npm run lint` to check for code quality issues. This command executes `eslint src --ext js && eslint test --ext ts && eslint example --ext js`.

### Building

-   The build command is `npm run build`, which runs `rollup -c`.

### Testing

-   Run tests with `npm run test`. This command first builds the project and then runs the tests using `NODE_OPTIONS='--import=tsx' mocha --require test/local_setup.ts "test/*.test.ts"`.

## Coding Style

### Naming Conventions

-   **Filenames:** `snake_case` (e.g., `my_module.js`).
-   **Local Functions:** `_camelCase` (e.g., `_calculateTotal()`).
-   **Exported Functions:** `camelCase` (e.g., `calculateTotal()`).
-   **Local Variables:** `snake_case` (e.g., `let my_variable = 1;`). Use short, concise names (e.g., `opts`, `res`, `req`, `i`, `total`).
-   **Global Variables:** `g_myGlobalText`.
-   **Global Constants:** `ALL_CAPS` (e.g., `const MAX_ITEMS = 10;`).
-   **Function Parameters:** Functions should take a `params` object for incoming data and pass an `opts` object to other functions.

### Asynchronous Code

-   Use the callback pattern: `_functionName(params, done)`.
-   Do not use `async/await`.
-   Parameters within the `params` object should be `camelCase`.
-   The `done` callback signature is `done(err, results)`.
-   When interacting with promise-based libraries, use the `.then(result => {}, err => {})` syntax and handle errors immediately.
-   For sequential asynchronous operations, prefer using `async.series`.

### JSON Data

-   All JSON keys should be in `snake_case` (e.g., `{"user_id": 123}`).