# Security Policy

JuanProxy stores upstream API keys and optional remote dashboard credentials in a local user data directory. Do not share real configuration files, screenshots, logs, or issue content that contains API keys, passwords, cookies, dashboard URLs tied to private accounts, or account identifiers.

## Reporting Vulnerabilities

Please do not report security issues in public issues if the report includes exploit details or sensitive data. Use a private security advisory on the hosting platform when available, or contact the maintainer through the project owner channel.

## Supported Versions

The `main` branch is the only supported development line until formal releases are published.

## Secret Handling Expectations

- Never commit real `config.json`, `.env`, logs, or exported account data.
- Treat `baseUrl`, API keys, sync usernames, passwords, cookies, and bearer tokens as sensitive.
- Redact credentials before attaching logs to issues.
- Use example domains such as `example.com` in tests, docs, and screenshots.
