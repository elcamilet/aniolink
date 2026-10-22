# Index

## Architecture

- [Architecture](./architecture.md) — Maps AnioLink's single-process signaling and relay server, its sender SPA, and the standalone browser receiver.

## Flows

- [HTTP relay flow](./flows/http-relay.md) — Follows a token through PUT and GET when at least one peer is a terminal, including the cross-notifications, claims and integrity checks.
- [WebRTC browser transfer](./flows/webrtc-browser-transfer.md) — Follows a browser-to-browser transfer from token and signaling through metadata, backpressure, eof/ack and disk streaming.

## Components

- [Backend relay](./components/backend-relay.md) — Documents the FastAPI module that owns tokens, signaling, the in-memory bridge state and the HTTP relay.
- [Browser clients](./components/browser-clients.md) — Documents the sender SPA and the standalone receiver page, the protocol they share, and the dead receiver code in the SPA.

## Decisions

- [Transfer integrity decisions](./decisions/transfer-integrity.md) — Explains why tokens are unique, claims are exclusive, expiry follows activity and uploads are verified against Content-Length.
- [Large-file strategy](./decisions/large-file-strategy.md) — Explains disk streaming, the Blob and native-download fallbacks, idle timeouts, 16 KB chunks and the ready/ack handshake.
