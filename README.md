# jev-intent-review

**Status: under construction. Nothing here is released yet; v0.1 is in progress.**

jev-intent-review reports a requirement violation in code the pull request did not change,
and points to the file and lines as evidence.

A diff-only review sees the lines that changed. The usual miss is elsewhere: an issue asks that
disabled users can no longer sign in, the pull request adds the check to the password login, and
the OAuth callback and the WebSocket handshake, which the pull request never touched, still let
them in. jev-intent-review starts from the stated intent (an issue, acceptance criteria, or text
you pass in), searches the repository after the change for every place that intent applies to,
and asks [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) — a model that answers
fixed, typed questions — one small question per place. The result is a table of requirements
against code locations, each marked `VERIFIED`, `VIOLATION`, `UNKNOWN` or `NOT_APPLICABLE`.

It only speaks about the places it found. It never claims that finding nothing means the code is
correct.

The design is in [docs/SPEC.md](docs/SPEC.md).

## License

MIT
