# Source publication policy

This repository contains application source and synthetic test data. It must not contain private recordings, project files, transcripts from real recordings, model weights, virtual environments, account settings, credentials, private keys, personal diagnostics or local user-profile paths.

## Before committing

1. Review `git diff --cached --stat` and the full staged diff. An ignore rule does not remove a file that Git already tracks.
2. Run `node scripts/check-publication.mjs` and `npm test`.
3. Scan the reviewed source snapshot with the free Gitleaks CLI using redacted output. Review every finding before publishing.
4. Use GitHub's privacy-preserving noreply commit email if you do not want a personal email in commit metadata.

The initial fork changes were prepared in a fresh clone of public upstream history, separately from the private editing workspace. Real transcript fixtures were replaced with invented examples; private-project integration tests were excluded. Source workers were reviewed separately from generated audio and runtime configuration.

The ignore rules and automated checks reduce accidental disclosure. They cannot establish that every future text file is non-confidential; review new test fixtures, screenshots, issue attachments and documentation before publication. Report security issues without including secrets or private media in a public issue.
