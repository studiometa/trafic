# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Trafic, please report it by emailing **security@studiometa.fr**.

Please include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days
- **Fix timeline** depends on severity:
  - Critical: 24-48 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: Next release

### Responsible Disclosure

We ask that you:
- Give us reasonable time to fix the issue before public disclosure
- Avoid accessing or modifying data that isn't yours
- Act in good faith to avoid privacy violations, data destruction, or service disruption

We will:
- Respond promptly to your report
- Keep you informed of our progress
- Credit you in the release notes (unless you prefer anonymity)

## Security Best Practices

When deploying Trafic:

1. **Use SSH keys** — Never use password authentication
2. **Restrict SSH access** — Use `AllowUsers` in sshd_config
3. **Enable Let's Encrypt** — Always use HTTPS in production
4. **Configure authentication** — Don't use `allow` policy for public-facing previews
5. **Keep updated** — Run `npm update` regularly for security patches
6. **Firewall** — Only expose ports 22, 80, and 443

See the [setup command](packages/trafic-agent/README.md#trafic-agent-setup) for automated server hardening.
