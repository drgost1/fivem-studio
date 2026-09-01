# Security policy

## Supported versions

Security fixes are provided for the latest published QB Studio release. The
`main` branch and older preview releases may change without a compatibility or
backport guarantee.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
[vulnerability reporting form](https://github.com/drgost1/fivem-studio/security/advisories/new)
and include:

- the affected QB Studio version and Windows version;
- a concise impact assessment and the security boundary crossed;
- minimal reproduction steps or a proof of concept;
- whether credentials, private source, or third-party services are involved;
  and
- any suggested mitigation, if known.

Remove live API keys, RCON passwords, server license keys, private source code,
and personal paths from the report. If a credential may have been exposed,
revoke or rotate it immediately; a software fix cannot invalidate a leaked
secret.

If the private reporting form is unavailable, contact a QBCore Framework
organization owner privately and request a secure reporting channel. Do not
fall back to a public issue containing exploit details. Repository owners
should keep private vulnerability reporting enabled and provide a monitored
security contact before promoting QB Studio beyond preview status.

## Disclosure

Please allow maintainers a reasonable opportunity to reproduce, fix, and ship
an update before public disclosure. Reports about SignPath certificate misuse
may also be sent to `support@signpath.io`; see `CODE_SIGNING_POLICY.md` for the
project's signing boundary.

General setup questions, feature requests, and non-sensitive defects belong in
the public issue tracker.
