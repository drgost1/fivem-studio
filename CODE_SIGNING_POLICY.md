# Code signing policy

QB Studio is an open-source project maintained by the QBCore Framework
community. This policy defines which builds may receive the project's public
Authenticode signature and how those builds are produced.

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Current status

QB Studio has applied to the SignPath Foundation open-source program. Releases
published before that approval are unsigned. A download must not be treated as
SignPath-signed unless Windows reports a valid Digital Signature issued by
SignPath Foundation.

When onboarding is complete, the first signed release will be published as a
new version. Existing release assets will not be silently replaced.

## Source and build requirements

Release signing is limited to artifacts that:

- are built from the public
  [`qbcore-framework/qb-studio`](https://github.com/qbcore-framework/qb-studio)
  repository;
- correspond to a commit on the protected `main` branch;
- are produced by the repository's checked-in GitHub Actions release workflow
  on a GitHub-hosted Windows runner;
- pass the repository's tests, type checks, complete moderate-threshold
  dependency audit, and packaged-runtime verification; and
- are submitted through the SignPath integration with verified source and build
  origin.

Local developer builds, pull-request artifacts, externally supplied binaries,
and rebuilt historical artifacts are not eligible for the public release
signature. A release exception requires explicit approval by a signing
approver and must remain traceable to public source and a reproducible build
workflow.

## Roles

- **Committers and reviewers:** QBCore Framework repository collaborators with
  write or review responsibility, listed through the
  [QBCore Framework organization](https://github.com/orgs/qbcore-framework/people).
- **Signing approvers:**
  [QBCore Framework organization owners](https://github.com/orgs/qbcore-framework/people?query=role%3Aowner),
  who authorize production signing requests and signing-policy changes.

No individual committer is permitted to export or possess the SignPath
Foundation private signing key.

## Release verification

Official downloads are published on the
[QB Studio releases page](https://github.com/qbcore-framework/qb-studio/releases).
For signed releases, users should open the installer's **Properties > Digital
Signatures** tab and confirm that Windows reports a valid SignPath Foundation
signature. GitHub build provenance can be checked independently with:

```powershell
gh attestation verify <installer> -R qbcore-framework/qb-studio --signer-workflow qbcore-framework/qb-studio/.github/workflows/release.yml
```

Authenticode and GitHub provenance are complementary: the Windows signature
identifies the publisher and detects tampering, while the GitHub attestation
ties the published file to the repository's release workflow.

## Reporting concerns

Report suspected signing-policy violations through the
[QB Studio issue tracker](https://github.com/qbcore-framework/qb-studio/issues)
without including credentials, private source code, or exploitable security
details. Reports about misuse of a SignPath Foundation certificate may be sent
directly to `support@signpath.io`.

See the [privacy policy](PRIVACY.md) for the data and network behavior of QB
Studio itself.
