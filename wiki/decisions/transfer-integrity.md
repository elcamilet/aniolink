---
title: Transfer integrity decisions
type: decision
responsibility: Explains why tokens are unique, claims are exclusive, expiry follows activity and uploads are verified against Content-Length.
sources:
  - backend/aniolink.py
  - backend/tests/test_transfer.py
  - backend/tests/test_unit.py
synced: 72f38a0
confidence: high
related:
  - ../architecture.md
  - ../flows/http-relay.md
  - ../components/backend-relay.md
---

# Transfer integrity decisions

The 2026-10 refactor replaced a fixed-TTL, optimistic relay with a claimed and verified one. Each decision below was made to remove a failure that showed up with 1 KB and 15 GB files, and each has an alternative that was deliberately not taken.

## Unique token, with retry

`generate_token` loops up to 100 times against `active_bridges` (`aniolink.py:80`). A four-character token space is large, but a collision would overwrite a live bridge and orphan its peers. The alternative — trust the birthday bound — was rejected because the failure is silent and the retry is cheap. If the loop cannot find a free token the endpoint returns `503` instead of reusing one.

## Exclusive claims over optimistic reads

`PUT` and the raw `GET` set `upload_claimed` and `download_claimed` before their first `await` (`aniolink.py:283`, `aniolink.py:352`). A second request gets `409`. Without the claim, two GETs would read the same `request.stream()` concurrently and interleave bytes, and a second PUT would replace the upload stream under the first sender. A per-token `asyncio.Lock` was considered; the single-threaded event loop makes the synchronous flag sufficient and avoids a waiter that could never be released.

## Activity expiry, not creation expiry

`cleanup_expired` expires on `last_activity` and skips any bridge with a peer socket or `transfer_active` (`aniolink.py:199`). The old rule used `created`, so a transfer longer than `TIMEOUT_SECONDS` lost its token mid-stream even though both sides were active. Raising the timeout was rejected: it delays cleanup for abandoned tokens and still imposes a ceiling on transfer duration.

## Verify known lengths, report the shortfall

When `Content-Length` exists, `stream_direct_p2p` compares `bytes_transferred` with it in `finally` (`aniolink.py:185`). A receiver disconnect is caught as `CancelledError` and recorded; a stream error keeps its message (`aniolink.py:172`). The waiting PUT turns the recorded error into `502` (`aniolink.py:310`). The alternative — count by buffering the body — violates the no-storage/no-full-buffering constraint. For chunked uploads without a declared length, the stream ending is the only signal; the system does not invent a size.

## Safe filename encoding

The URL filename is sanitized for path separators, control characters and quotes, then emitted as an ASCII `filename` plus RFC 5987 `filename*` (`aniolink.py:58`, `aniolink.py:74`). A raw quoted name was rejected because a quote or newline can break the header, and dropping non-ASCII loses the name that the user sees. The ASCII fallback still names the file in clients that ignore `filename*`.

The tests encode these choices: `test_transfer.py` covers both `409` cases and the active-vs-idle expiry, and `test_unit.py` covers the token retry, the header and metadata capture from the second socket.
