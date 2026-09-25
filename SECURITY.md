# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through this repository's GitHub Security
Advisories. Do not open a public issue containing credentials, cookies, tokens,
private messages, personal data, unredacted request URLs, or live account details.

If private reporting is unavailable, open a public issue containing only a minimal,
synthetic description and ask the maintainer to establish a private channel.

## Sensitive files

Never attach or commit any of the following:

- `.auth/` or Playwright storage-state files;
- `.env` files or credentials;
- real message exports or `.partial` candidates;
- screenshots, HTML, logs, or diagnostics containing account or message content;
- cookies, authorization headers, CSRF tokens, signed URLs, or member identifiers.

Use synthetic fixtures for reproductions. If a secret is exposed, revoke or rotate it
before doing anything else; deleting it from the latest commit is not sufficient
because Git history and forks may retain it.

## Supported version and scope

Security fixes target the current default branch. Reports about unintended network
writes, bypasses of the read-only policy, credential disclosure, path traversal, or
unsafe persistence are in scope. Questions about whether LinkedIn permits a
particular use are platform-policy or legal questions, not security vulnerabilities;
see [`LEGAL.md`](LEGAL.md).
