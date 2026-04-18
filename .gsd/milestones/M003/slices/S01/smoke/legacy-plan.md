---
id: T01
slice: S03
milestone: M001
---

# T01: Bootstrap API client

**Slice:** S03  **Milestone:** M001

## Goal

Create the base HTTP client wrapper for the external payments API, including auth header injection and retry logic.

## Must-Haves

- `src/api/payments-client.js` exists and exports `createClient(config)`
- `createClient` accepts `{ baseUrl, apiKey, timeout }` — all required
- Retry on 429 and 5xx with exponential back-off (max 3 retries)
- Unit tests in `tests/api/payments-client.test.js` cover happy path + retry path
- No API keys hardcoded — read from `config` argument only

## Steps

1. Read existing HTTP utility in `src/utils/http.js` to check reuse opportunities.
2. Create `src/api/payments-client.js` using the shared `request` helper from `http.js`.
3. Implement retry decorator with back-off.
4. Write unit tests mocking `http.js`.
5. Verify with `npm test -- --testPathPattern payments-client`.
