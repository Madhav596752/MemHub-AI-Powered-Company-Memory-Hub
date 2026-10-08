# Authentication Guide

## Overview
MemHub provides enterprise-grade identity integration with OAuth 2.0 and JWT.

## Security Architecture
The authentication pipeline uses standard RFC 7519 tokens with RSA-256 signatures.
All API requests must include the header:
`Authorization: Bearer <access_token>`

### Token Expiration
- Access tokens expire after 1 hour (3600 seconds).
- Refresh tokens are stored in secure HTTP-only cookies with a 30-day lifetime.
- Revocation endpoints immediately blacklist token IDs in the in-memory cache.
