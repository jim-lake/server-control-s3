# Style Guide

This document outlines the coding style conventions for this project.

## Project Structure

-   **Source Code:** All source code is located in the `src` directory.
-   **Output Artifacts:** The `dist` directory is used for build outputs and should not be manually edited or evaluated by the AI.

## Tools

Only use npm.

## Code Formatting

Before committing any changes, run `npm run pretty` to format the code.

## Naming Conventions

### Functions

-   **Local Functions:** Local (non-exported) functions should be named using camelCase, prefixed with an underscore.
    -   Example: `_calculateTotal()`
-   **Exported Functions:** Exported functions should be named using camelCase.
    -   Example: `calculateTotal()`
-   **Parameter & Options:** Functions take params and pass opts to other
functions.  That allows you to allows differentiate incoming and outgoing variables.
    -   Example: ```
function consumer(params: any) {
    const opts = { foo: 1, bar: params.bar };
    anotherFunction(opts);
}
```

### Variables

-   **Local Variables:** Local variables should be named using snake_case.
    -   Example: `let my_counter = 0;`
-   **Global Constants:** Global constants should be named using ALL_CAPS with underscores separating words.
    -   Example: `const MAX_RETRIES = 3;`
-   **Short names:** Use short consise names for local function variables.
    -   Example: `opts`, `res`, `req`, `i`, `total`
-   **Global Variables:** Use `g_myGlobalText` for global non-constant variables.

### Files

-   Filenames should be in snake_case.
    -   Example: `my_module.ts`, `user_service.js`

### Asynchronous Functions

-   **Callback Style:** Asynchronous functions should use callbacks and not `async/await`. They should follow the `_functionName(params, done)` pattern.
-   **Parameters:** Parameters within the `params` object should be `camelCase`.
-   **Callback Signature:** The `done` callback function should have the signature `done(err: any, results: any)`, where `results` can be a single value or an object.

    -   Example:
        ```javascript
        function _fetchData(params, done) {
            if (!params.userId) {
                return done('userId is required');
            }
            // ... asynchronous operation ...
            const results = { data: 'some data' };
            return done(null, results);
        }
        ```

-   **Async Libraries:** When using libraries that use async or promises,
interact with them using `asyncFunction(params).then(result => {}, err => {})`
style and make sure to handle all errors immediately.

-   **Async Code Flow:** Prefer `async.series` for linear code flow with one
operation per block in the series, handling errors at each step.  The success
chain should progress linearly through the series.

## JSON Data

-   **Format:** All JSON data, for example in API requests and responses, should use `snake_case` for keys.
    -   Example:
        ```json
        {
            "user_id": 123,
            "first_name": "John"
        }
        ```
