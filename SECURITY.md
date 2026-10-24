# Security policy

## Supported versions

Azure DevOps installs the latest published version of an extension in every organization, so only the latest version (4.0.x) receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

1. On the repository, open **Security › Report a vulnerability** and describe the problem, the steps to reproduce it and its impact.
2. If private reporting isn’t available, open an issue that only asks for a private contact, without any details.

Use test values in your report, never real credentials, tokens, private keys or personal data. You’ll get an acknowledgment, and the fix is released as a new version of the extension. Please allow a reasonable time for the fix before you disclose the problem.

## Known limits, by design

REST Picklist runs entirely in the browser, without a server of its own. That brings trade-offs, which the documentation states openly. They aren’t treated as vulnerabilities, but a report that shows the extension exposing more than described here is.

- **Credentials reach the browser.** A configuration’s credential (password, token, API key, client secret or private key) is sent to the browser of everyone who opens a work item that uses it, so those people can read it with developer tools.
- **Extension data has no per-user permissions.** Configurations, credentials and the security policy are kept in the extension’s data, which any member of the organization can read and write through the Azure DevOps REST API. The setup page’s permission rules and the security policy are guard rails, not access control. Credentials are hidden on every screen, not encrypted.
- **The permission check can be refused.** If Azure DevOps refuses the setup page’s permission check, the page says so and doesn’t limit editing, so Project Collection Administrators aren’t locked out. Azure DevOps still checks Edit process permission when a process’s controls change.
- **OAuth 2.0 tokens are requested from the browser**, so the token service must accept requests from the extension’s origin (CORS). Microsoft Entra ID refuses client credentials sent from a browser.

## How the extension protects your data

The Marketplace page ([overview.md](overview.md)) describes the protections built into the control and the setup page under “Security model”, who can change what under “Permissions”, and the organization’s rules under “Security policy”. Data handling is described in [PRIVACY.md](PRIVACY.md).
