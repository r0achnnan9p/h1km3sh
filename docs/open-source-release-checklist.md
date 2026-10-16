# Open-source release checklist

This list is for the maintainer. A successful grep or a clean current checkout does **not** mean that historical commits can safely be published.

- [ ] Inspect all tracked files, branches, tags, Git history and any release artifacts for secrets, private recordings, usernames, passwords, personal deployment domains, private URLs and identifying infrastructure.
- [ ] Revoke/rotate any secret which was ever committed, even if later deleted.
- [ ] Decide whether the *existing history* is safe to publish or a new, clean public repository with a sanitized source snapshot is more appropriate.
- [ ] Generalize internal-only runbooks and production-specific URLs without breaking existing production deployments.
- [ ] Confirm self-hosted GitHub Actions runners cannot execute untrusted public PR code, and remove unnecessary production-specific CI from the public snapshot.
- [ ] Verify the right to release original code under MIT; preserve third-party license notices and check shipped binaries.
- [ ] Check direct-source startup binds30001 to127.0.0.1 and only the authenticated30002 gateway is reachable through reviewed HTTPS/proxy settings.
- [ ] Run tests and real-browser/recording verification; be explicit about existing test failures.
- [ ] Only publish the exact reviewed commit after an explicit maintainer visibility decision.
- [ ] Apply to Codex for Open Source without inventing stars, downloads or community adoption.
