# Support

## Get help

Open an issue at https://github.com/OscarArguedasB/RestDataMappingPicklist/issues. Questions asked on the Marketplace page go there too.

To help reproduce the problem, include:

- The extension version (**Organization settings › Extensions**) and your browser.
- What you expected and what happened, with the exact message the control or the setup page showed.
- How the control is set up: a configuration name, settings from before 4.0, or nothing yet.
- The configuration, exported from the **Configurations** tab (**More actions › Export**). Exported files never contain credentials or user names.
- If a request fails, the result of **Test and preview** in the configuration editor, and the shape of the response with personal data replaced.
- For OAuth 2.0: which token service you use (for example Keycloak or an API gateway), whether the test got a token, and the error code the token service sent.
- If the page won’t let you change something: whether you’re a Project Collection Administrator or have **Edit process** permission on the process.

Never post passwords, tokens, API keys, client secrets, private keys, certificate files or their passwords, or personal data in an issue.

## What’s supported

- The latest version of the extension (4.0.x), on Azure DevOps Services. Azure DevOps Server isn’t supported.
- Current versions of Microsoft Edge, Google Chrome, Mozilla Firefox and Safari.
- OAuth 2.0 token services that accept the client credentials grant from a browser. Microsoft Entra ID refuses it, so it can’t be supported.

Support is provided on a best-effort basis by the maintainer.

## Permission requests

The source code is published for transparency and review (see [LICENSE](LICENSE)). To ask for permission to use it in other ways, open an issue.

## Security issues

Don’t report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
