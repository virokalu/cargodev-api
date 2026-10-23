# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private reporting: the **Security** tab -> **Report a vulnerability**.

Include: what you found, how to reproduce it, and the impact. We aim to acknowledge reports within 3 business days.

## Scope

In scope: this repository's code and its default configuration.
Out of scope: third-party services, social engineering, denial of service by volume.

## If you find a secret in the repo or its history

Report it privately right away. The owner will rotate the credential first; removing the commit alone is not enough.

## For contributors

- Never commit secrets. `.env` is git-ignored; `.env.example` holds names only.
- Secret scanning and push protection are enabled on this repository.
- Production credentials are never used on developer machines.
