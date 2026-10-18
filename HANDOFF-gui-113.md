# GUI #113 review fixes

Merged current main while preserving parent-session forwarding and the streamed
refusal path. The broker now creates one validated client request ID per
incoming model request, forwards it on every model attempt, returns it in
synthetic 503 responses and response headers, includes it in interruption SSE
errors, and attaches it to retry/fallback logs and events. The original supplied
ID remains stable across attachment, auth, connection and sub-agent retries.

Verification: bun test apps/server/src/mars-gateway-broker.test.ts — 66
passed, 0 failed, 1 existing recorded-stream test skipped because
MARS_RECORDED_SSE_DIR was not provided. git diff --check passed. Not
deployed or released.
