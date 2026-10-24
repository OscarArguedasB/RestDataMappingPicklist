Pick work item values from any REST API, with instant search, multiple values, paging and the option to copy more data from the chosen item into other fields. API settings are managed in one place, by process, and can sign in with OAuth 2.0 using a client secret or a certificate.

![The REST Picklist control on a work item form: typing filters the list, each customer shows its email as a second line, and picking several fills the field and copies their details into other fields](img/Usage.gif)

Works with the ServiceNow Table API, GitHub, OData services, Azure DevOps REST APIs, or any HTTPS endpoint that returns JSON.

## What it does

- **Loads only when needed.** Your API isn’t called until someone opens the list, so forms open fast. You can choose to load the list when the work item opens instead.
- **Search as you type.** Matches any part of a value or its second line, ignoring case and accents, with the best matches first and highlighted. Lists with thousands of items stay smooth.
- **Cascading lists.** Use `$(Field.ReferenceName)` in the URL or parameters. The list reloads when that field changes.
- **Copy to other fields.** Properties of the picked item, like an ID or email, go into other work item fields. Clearing the field empties them again.
- **Clear field states.** A red outline and “(required)” when a required field is empty, and a blue outline and dot for a change that isn’t saved yet. Fields made required by work item rules are detected automatically.
- **One place for API settings.** Configurations live in **Organization settings › Extensions › REST Picklist**, listed under the processes that use them. A control on a form only names its configuration.
- **Sign in your way.** None, Basic, Bearer token, API key, or OAuth 2.0 client credentials with a client secret or a certificate. Credentials are write-only: once saved, they’re never shown again.
- **Test before you save.** The setup page calls your API from your browser and shows the real control with your data.
- Light, dark and high contrast themes, keyboard and screen reader support, and touch-friendly sizing on phones.

![The REST Picklist control on a work item form, with its list open](img/screenshots/control.png)

## What’s new in 4.0

4.0 changes how REST Picklist is set up. Work item forms look and work as before.

- **Configurations in Organization settings.** API settings move from the process editor’s **Options** tab to **Organization settings › Extensions › REST Picklist**, grouped by process. One configuration can be shared by several processes, so you set up an API once.
- **A shorter Options tab.** It now has only **Field to fill in** and **Configuration name**.
- **OAuth 2.0.** Client credentials (application permissions), set up like Postman’s “Configure New Token”, with a client secret or a certificate.
- **Write-only credentials.** Passwords, tokens, API keys, client secrets and private keys are stored apart from the settings, tied to the address they’re sent to, and never shown again.
- **Edit rights follow processes.** Project Collection Administrators can change every configuration. People with **Edit process** permission can change the configurations shared with their processes.
- **Move existing controls in a few clicks.** The setup page finds controls still set up in the process editor and moves their settings into configurations, with their secret when Azure DevOps shows it.
- **Safe renames.** A renamed configuration still answers to its former names.
- **Controls from earlier versions keep working** until you move them, and files exported by 3.0 import into 4.0.

Read “Moving from 3.x” below before you update.

## Set it up

1. Open **Organization settings › Extensions › REST Picklist**. On the **Configurations** tab, choose the process your work items use and select **New configuration**.
2. Enter a **Name**. Under **Shared with**, add every process whose controls should use it.
3. Fill in **Connect** (the endpoint and how to sign in), **Credentials** if it signs in, and **Choose the values**. Optional sections cover multiple values, copying to other fields, paging and behavior.
4. Select **Run test**. The preview is the real control, with your data. Then select **Save configuration**.
5. Add the control to a form: open **Organization settings › Boards › Process**, then your inherited process and the work item type, choose **Add custom control** and pick **Rest Data Mapping Picklist**. On the **Options** tab, choose the **Field to fill in** and enter the configuration’s name in **Configuration name**. On the **Layout** tab, give the control a label.

A control that’s already on a form can get its configuration on the setup page instead: under **Controls in this process**, choose the configuration and select **Apply**.

![The REST Picklist setup page in Organization settings: configurations listed by process, the configuration editor, and a test with a live preview of the control](img/Settings.gif)

- Custom controls go in inherited processes. System processes (Agile, Scrum, CMMI and Basic) can’t hold them, so the page lists them under “Can’t hold custom controls”. Hosted XML processes are listed too; in their XML, the control takes the same two inputs, `FieldName` and `Configuration`.
- A control looks up its configuration by name among the ones shared with its work item’s process. Case doesn’t matter, and former names work too.
- A control with an empty **Configuration name**, and no settings from before 4.0, shows “API configuration has moved. You can find it under Organization settings › Extensions › REST Picklist, or click here.”, where “click here” opens the page.
- The test runs in your browser under your organization’s security policy, exactly like the control on the form. It uses the credential you just entered, or the saved one, which is read for that test only.

## Configurations by process

![The Configurations tab: the processes, the configurations shared with the chosen process with their status, and the REST Picklist controls on its forms](img/screenshots/setup-configurations.png)

The **Configurations** tab lists your processes. For the one you choose, it shows:

- **What you can do there**: “You can edit this process’s configurations.”, or “View only: you need Edit process permission on Contoso Agile.”
- **Its configurations.** Each has a status line like “api.contoso.com · OAuth 2.0 with a certificate · expires 30 Sept 2027 · used by 3 controls”, problems such as “Secret not set” or “Certificate expires in 12 days”, the processes it’s shared with and who changed it last. Select **Edit** (or **View**), or open **More actions** for **Duplicate**, **Share…**, **Export** and **Delete**.
- **Import**, **Export all** and **New configuration**.
- **Controls in this process**: every REST Picklist control on the process’s forms, with the configuration it uses. Choose another one and select **Apply**; the change applies to the process right away. Controls set up before 4.0 say “Settings in the process editor” and offer **Move**.
- **Not used by any process**, for Project Collection Administrators: configurations whose processes no longer exist. Share them with a process, or delete them.

Good to know:

- **Names** are unique within each process, ignoring case, and can have up to 100 characters. Former names count too.
- **Renaming** keeps up to five former names (“Also answers to …”), so controls that still use an old name keep working. After you save, the page offers to update those controls.
- **Sharing.** Controls in every process a configuration is shared with can use it. A configuration stays shared with at least one process; to stop using it everywhere, delete it.
- **Duplicate** copies the settings and the credential, which nobody gets to see, into a new configuration named “… copy”.
- **Delete** removes the configuration and its credential. Controls that use it show an error until you choose another one.
- **Forms pick up changes within five minutes**, because each browser tab keeps the list of configurations that long. A new or renamed configuration is found right away.

### Configuration files

**Export** and **Export all** write a JSON file with the settings, never credentials or user names. **Import** reads such files into the chosen process, including files exported from 3.0’s Saved configurations tab, and lets you pick and rename what comes in. Enter the credentials in each imported configuration.

```json
{
  "format": "rest-picklist-configurations",
  "version": 2,
  "exportedAt": "2026-10-22T14:03:00.000Z",
  "configurations": [
    {
      "name": "Customers API",
      "source": "Contoso Agile, Contoso Scrum",
      "settings": {
        "RestServiceAddress": "https://api.contoso.com/customers",
        "AuthMethod": "OAuth 2.0",
        "SecondLineProperty": "email",
        "AllowMultiple": "true",
        "AdvancedSettings": "{\"paging\":{\"type\":\"nextLink\",\"nextLink\":\"@odata.nextLink\"}}",
        "OAuthSettings": "{\"tokenUrl\":\"https://auth.contoso.com/oauth2/token\",\"clientId\":\"picklist\",\"clientAuthentication\":\"privateKeyJwt\"}"
      }
    }
  ]
}
```

`source` names the processes the configuration was shared with, for your information. Settings are keyed by the ids the Options tab used before 4.0, which is why files from 3.0 still import. The editor writes them for you.

## Settings

![The configuration editor: name and sharing, the connection and sign-in settings, the credentials and the values, with the test and live preview beside them](img/screenshots/setup-editor.png)

The editor groups a configuration’s settings in cards and sections. These are its labels:

| Setting                                                 | Example                                                                  | Notes                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                                                | `Customers API`                                                          | Required. Controls find the configuration by this name.                                                                                                                                |
| **Shared with**                                         | Contoso Agile, Contoso Scrum                                             | The processes whose controls can use it.                                                                                                                                               |
| Connect › **REST endpoint URL**                         | `https://api.contoso.com/customers`                                      | Required. HTTPS only. Work item values can go in the path or query string, like `…/regions/$(Custom.Region)/customers`, but not in the host name.                                      |
| Connect › **URL parameters (JSON)**                     | `{ "status": "active", "region": "$(Custom.Region)" }`                   | Added to the query string. The list reloads when a field used as `$(…)` changes.                                                                                                       |
| Connect › **Sign-in method**                            | OAuth 2.0                                                                | None, Basic, Bearer token, API key or OAuth 2.0. See “Sign-in and credentials”.                                                                                                        |
| **Credentials**                                         |                                                                          | The password, token, API key, client secret or certificate. Write-only.                                                                                                                |
| Choose the values › **JSON path to the list**           | `data.result`                                                            | Leave empty to find the list automatically. Dots for nesting, brackets for positions: `data.items[0]`. **Detect** calls the endpoint once and suggests the list and properties to use. |
| Choose the values › **Value property**                  | `name` or `owner.email`                                                  | Listed and saved in the field. Leave empty to use the most name-like text property. Set it to keep the choice stable.                                                                  |
| Choose the values › **Second line**                     | `email`                                                                  | Optional. Shown smaller under each value and searched too. Items with the same value but a different second line stay separate. The field still gets just the value.                   |
| Multiple values › **Allow multiple values**             |                                                                          | Stored as `A; B; C`. See “Multiple values” below.                                                                                                                                      |
| Copy to other fields › **Copy to other fields (JSON)**  | `{ "Custom.CustomerId": "id", "Custom.CustomerEmail": "contact.email" }` | Field reference name → property of the picked item. After a test, **Copy to field** adds a property of the first item. Clearing the field also empties these fields.                   |
| Paging › **How the API returns long lists**             | Next link                                                                | See “Paging” below.                                                                                                                                                                    |
| Paging › **Maximum items**                              | `10000`                                                                  | The most items to load, from 1 to 50,000, with or without paging.                                                                                                                      |
| Behavior › **Load the list when the work item opens**   |                                                                          | Off by default: the list loads when someone opens it, so forms open faster. Turn it on for small, fast APIs.                                                                           |
| Behavior › **Mark as required when empty**              |                                                                          | Adds a red outline only. Fields required by work item rules are detected automatically. To block saving, make the field required on the work item type.                                |
| Behavior › **Message when the value isn’t in the list** | `This customer is no longer active.`                                     | Shown under the field. Leave empty for a standard message.                                                                                                                             |
| Behavior › **Timeout**                                  | `30` seconds                                                             | How long to wait for each response, from 5 to 120 seconds.                                                                                                                             |

The field is chosen on each control (**Field to fill in**), so one configuration can fill different fields. Use a text field: Text (single line) or Text (multiple lines). A picklist field works only if it accepts values people type, because the extension can’t add items to it. Other field types show a configuration error on the form. The organization’s security policy can lower the page, item and time limits further.

For example, for this response:

```json
{
  "data": [
    { "id": 7, "email": "michael.lawson@example.com", "first_name": "Michael" },
    { "id": 8, "email": "lindsay.ferguson@example.com", "first_name": "Lindsay" }
  ]
}
```

use **JSON path to the list** `data`, **Value property** `email`, **Second line** `first_name` and **Copy to other fields** `{ "Custom.ExternalUserId": "id", "Custom.FirstName": "first_name" }`. If you leave both paths empty, the list at `data` is still found, but the value is picked for you: here `first_name`, because it looks like a name and is unique in every item.

### Paging

Choose how the API returns long lists under **Paging**:

| Choice                   | Settings (default)                                                                                                                                                                                                                             | Stops when                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **No paging**            |                                                                                                                                                                                                                                                | The whole list comes in one response.              |
| **Next link**            | **Where the next page link is**: a property of the response, like `@odata.nextLink` or `links.next`. Leave it empty to look in common places (`@odata.nextLink`, `nextLink`, `next`, `links.next`…), then in the `Link` header’s `rel="next"`. | There’s no next link.                              |
| **Page number and size** | **Page number parameter** (`page`), **Page size parameter** (`pageSize`), **Items per page** (100, up to 10,000), **First page number** (1, or 0)                                                                                              | A page has fewer items than **Items per page**.    |
| **Offset and limit**     | **Offset parameter** (`offset`), **Limit parameter** (`limit`), **Items per request** (100, up to 10,000)                                                                                                                                      | A page has fewer items than **Items per request**. |
| **Cursor**               | **Where the next cursor is** (required): a property of the response, like `meta.nextCursor`. **Cursor parameter** (`cursor`): the query parameter it’s sent in.                                                                                | The cursor is missing, empty or seen before.       |

Every choice also has **Maximum pages**, from 1 to 100 (10 by default), and stops at an empty page, at a page it already loaded, and at the page or item limit. When a limit cuts the list short, the list says “Showing the first N items”. Each page uses the same sign-in, and next links must stay on the endpoint’s own site (see “Security model”).

- **OData**: **Next link**, with **Where the next page link is** `@odata.nextLink`.
- **GitHub**: **Next link**, with **Where the next page link is** left empty, because GitHub sends it in the `Link` header. Add `{ "per_page": "100" }` to **URL parameters** for fewer requests.
- **An API that takes `?page=2&per_page=100`**: **Page number and size**, with **Page size parameter** `per_page` and **Items per page** 100.
- **ServiceNow Table API**: **Offset and limit**, with **Offset parameter** `sysparm_offset`, **Limit parameter** `sysparm_limit` and **Items per request** 1000, and **JSON path to the list** `result`.
- **Cursor**, for a response like `{ "items": [ … ], "meta": { "next_cursor": "c2Vjb25k" } }` that expects `?cursor=c2Vjb25k` for the next page: **Cursor**, with **Where the next cursor is** `meta.next_cursor`.

### Multiple values

Check **Allow multiple values** to pick several items. Picked values show as chips in the field, and the list stays open after each pick. To take a value off, use its chip’s remove button, pick the checked item again, or press Backspace in the empty search box.

- **Storage.** The field holds the values separated by a semicolon and a space: `Contoso; Fabrikam; Northwind`. Each value appears once. A value that contains a semicolon can’t be picked in this mode.
- **Field types.** Text (single line) holds 255 characters, so when the next value wouldn’t fit, the control says so and doesn’t add it. Text (multiple lines) has no such limit, so use it for long lists. Multi-line fields store HTML: the control reads their text and writes values as plain text, never as markup.
- **Copy to other fields.** The choice **With several picks, Copy to other fields should** decides what each mapped field gets: **Copy every picked item’s value**, joined with `; ` (the default), or **Copy only the first**. Removing the last value, or clearing the field, empties the mapped fields.

## Sign-in and credentials

| Sign-in method | In Connect                               | In Credentials                       | Sent to the API as                                         |
| -------------- | ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| None           |                                          |                                      | Nothing                                                    |
| Basic          | **User name**                            | Password                             | `Authorization: Basic …`                                   |
| Bearer token   |                                          | Token                                | `Authorization: Bearer …`                                  |
| API key        | **Header name** (`x-api-key` by default) | API key                              | That header                                                |
| OAuth 2.0      | The token settings (see “OAuth 2.0”)     | Client secret, or certificate or key | `Authorization: Bearer …`, with a token from the token URL |

Headers the browser controls, like `Cookie`, `Host` or `Origin`, can’t carry an API key.

**Credentials are write-only.** The **Credentials** card shows one of these:

- **Not set**, with a field for the secret, or a file picker for a certificate.
- **Set · changed by Ana Díaz on 22 Oct 2026**, with **Replace** and **Remove**. For a certificate it also shows the subject, the issuer, when it expires and the SHA-1 thumbprint, with **Copy** to compare it in your token service, and the SHA-256 thumbprint. **Replace** shows an empty field, and the saved credential stays until you save.

Good to know:

- **Tied to an address.** A credential is saved for the site it’s sent to: the API’s for Basic, bearer tokens and API keys, and the token URL’s for OAuth 2.0. The card says so, for example “Sent only to api.contoso.com.” Point the configuration somewhere else and you must enter the credential again: “You changed where the secret is sent, so enter it again.” Forms never send a credential to another address.
- **Changing the sign-in method** to one that can’t use the saved credential, or to None, asks first, and removes the credential when you save.
- **Never shown, exported or logged.** Credentials don’t appear on the page, in exported files, in error messages or in browser storage. The test reads the saved one only for that run.
- **But not hidden from browsers.** The card says it plainly: “Hidden on every screen, but anyone who opens a work item that uses it can read it with browser developer tools. Use a read-only credential limited to this API.” See “Security model”.

On a form, a configuration whose credential isn’t set says “This configuration signs in, but its secret isn’t set. Ask an administrator to set it in Organization settings › Extensions › REST Picklist.”

## OAuth 2.0

OAuth 2.0 here is the client credentials grant: the configuration signs in as an application, with its own permissions, not as the person using the form. When OAuth 2.0 is the selected sign-in method, the setup page shows this notice in red text, right under the method:

> **OAuth 2.0 uses the app registration’s application permissions (client credentials) to get the token.** It doesn’t use delegated permissions or a sign-in page, and nothing extra needs to be deployed.
>
> The token is requested from this browser, so the token URL must accept requests from Azure DevOps (CORS). Microsoft Entra ID refuses client credentials sent from a browser, so Entra app registrations won’t work.

### Compared with Postman

The fields follow Postman’s “Configure New Token” for the Client Credentials grant type:

| In Postman                                                     | In REST Picklist                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token Name                                                     | No field: the configuration’s name plays that role. Tokens are requested automatically and kept in memory.                                                                                  |
| Grant type                                                     | Shown as text: “Client credentials (application permissions)”. It’s the only one.                                                                                                           |
| Callback URL, Auth URL, State                                  | Not shown. Postman uses them only for Authorization Code, where a person signs in (delegated permissions).                                                                                  |
| Access Token URL                                               | **Access token URL**                                                                                                                                                                        |
| Client ID                                                      | **Client ID**                                                                                                                                                                               |
| Client Secret                                                  | **Credential**: **Client secret**, entered in the **Credentials** card. Or **Certificate**: see “Certificates and keys” below.                                                              |
| Scope                                                          | **Scope (optional)**, space-separated                                                                                                                                                       |
| Client Authentication                                          | For a client secret, **Client authentication**: **Send as Basic Auth header** (the default) or **Send client credentials in body**. A certificate always signs a JWT, so there’s no choice. |
| Advanced options: Audience, Resource, token request parameters | **Advanced**: **Audience (optional)**, **Resource (optional)**, **Extra token parameters**, and with a certificate **Assertion audience (optional)**                                        |

Extra token parameters are saved as plain settings, so don’t put secrets in them. They can’t replace the parameters REST Picklist sends itself, like `grant_type`, `client_id`, `client_secret` or `scope`.

### The token request

- `POST` to the access token URL, as a form (`application/x-www-form-urlencoded`), with `grant_type=client_credentials`, and `scope`, `audience`, `resource` and the extra parameters when they’re set.
- **Send as Basic Auth header**: `Authorization: Basic` with the client ID and secret, each form-encoded as RFC 6749 asks. Some token services don’t decode them, so a secret with characters like `+`, `/`, `=` or `%` fails there: send the credentials in the body instead.
- **Send client credentials in body**: `client_id` and `client_secret` in the form. There’s no `Authorization` header, so the browser skips the CORS preflight request, which suits more token services.
- **Certificate**: `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a `client_assertion`, a JWT signed with the private key (private_key_jwt, RFC 7523). Its issuer and subject are the client ID, its audience is the token URL (or **Assertion audience**), and it’s valid for five minutes. Its header names the certificate by its thumbprints (`x5t`, `x5t#S256`), or carries the **Key ID** (`kid`).
- The answer must be JSON with an `access_token`, and a `token_type` of `Bearer` when it has one. `expires_in` says how long the token lasts.

### Certificates and keys

- Choose **Certificate** under **Credential**. Then, in **Credentials**, choose or drop a file, or select **Paste PEM instead**.
- It takes a .pfx or .p12 file with its password, including Windows exports protected with Triple DES, or a certificate (.pem, .cer, .crt or .der) with its private key (.pem or .key), in one file or two, or pasted PEM. An encrypted key asks for its password.
- **I have a key without a certificate** takes a key alone, with an optional **Key ID**, for token services that know the key by its ID.
- Keys can be RSA, of 2048 bits or more, or EC on P-256, P-384 or P-521. RSA keys sign with RS256 unless you choose RS384, RS512, PS256, PS384 or PS512 under **Signing algorithm**. EC keys use ES256, ES384 or ES512.
- The file is read in your browser. Only the private key and the certificate’s details (subject, issuer, validity and thumbprints) are saved, never the file or its password. The page warns when the certificate expires within 30 days, has expired or isn’t valid yet, and the configuration’s status line does too.
- A format it can’t read gets a clear message, often with the `openssl` command that converts it.

### How tokens are used

- A token is requested when a list loads, kept in memory only, and reused until a minute before it expires, or for five minutes when the token service doesn’t say. It’s never stored or shown: the test only says “Got a token · expires in 59 min”.
- Only the token goes to the API, as `Authorization: Bearer …`. The client secret or key is only used with the token URL.
- If the API answers 401, the control gets a new token and tries once more.
- The token URL gets the same checks as API endpoints: HTTPS, and the security policy’s allowed hosts and private network block. Field values can’t be used in it. Token requests send no cookies and don’t follow redirects, so use the final address.

### Which token services work

A token service works when it accepts the client credentials grant from a browser: it must answer requests from the extension’s origin with CORS (see “CORS”). For example, Keycloak does when the extension’s origin is among the client’s **Web origins**. An API gateway you run in front of your token service can do the same. **Run test** shows right away whether your token service allows it.

### Microsoft Entra ID

Microsoft Entra ID refuses client credentials in any request that carries an `Origin` header, and every request a browser sends has one. So Entra app registrations, and APIs that only accept Entra tokens, such as Microsoft Graph, can’t be used with OAuth 2.0 here. Nothing is deployed that could request the token elsewhere.

The setup page recognizes Entra token URLs (`login.microsoftonline.com` and the hosts of the other Microsoft clouds, `*.ciamlogin.com` and `*.b2clogin.com`). It shows “Microsoft Entra ID refuses client credentials sent from a browser, so this token URL won’t work. Use a token service that accepts requests from Azure DevOps.” under the field, doesn’t save the configuration, and flags configurations that already use such a token URL. A form says the same if its token request fails. A custom domain in front of Entra can’t be recognized, but its token requests fail the same way.

### Not supported

- Authorization code (with or without PKCE), device code, or any other flow where a person signs in (delegated permissions).
- The password grant.
- `client_secret_jwt`, a JWT signed with the client secret.
- Mutual TLS: a web page can’t present a client certificate of its choice.
- Refresh tokens: a new token is requested when the old one expires.

## Permissions

### Who can do what

| Action                                                       | Who                                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| See configurations, never their credentials                  | Anyone who can open the page                                                                                     |
| Create a configuration in a process                          | Project Collection Administrators, and people with **Edit process** permission on that process                   |
| Change a configuration: its settings, name and credentials   | Project Collection Administrators, and people with **Edit process** permission on any process it’s shared with   |
| Share it with another process                                | People who can change it, if they also have **Edit process** permission on that process                          |
| Stop sharing it with a process                               | People with **Edit process** permission on that process. It must stay shared with at least one.                  |
| Delete a configuration                                       | Project Collection Administrators, and people with **Edit process** permission on every process it’s shared with |
| Assign configurations to controls, move or clean up controls | People with **Edit process** permission on that process. Azure DevOps checks this too.                           |
| Change the security policy                                   | Project Collection Administrators                                                                                |

The page checks your permissions with Azure DevOps when it opens. People who can only view see the editor with its settings written out, without a test. If the check doesn’t work:

- **Azure DevOps can’t be reached, or has a problem.** The page says “Couldn’t check your permissions (…). Editing is turned off until it works.”, with **Try again**, and everything stays view-only.
- **Azure DevOps refuses the check.** This can happen for everyone if the extension isn’t allowed to ask. The page says “Couldn’t verify your permissions (…), so editing isn’t limited here.” and lets everyone edit, the security policy included, so that Project Collection Administrators aren’t locked out. Azure DevOps still checks **Edit process** when a process’s controls change.

**A guard rail, not a lock.** Azure DevOps checks process permissions only when a process layout changes, as when you assign a configuration to a control or move one. Configurations, credentials and the security policy are kept in this extension’s data, which Azure DevOps lets any member of the organization read and write through its REST API. The rules above are kept by the setup page: they keep process editors to their processes, but they don’t stop someone who calls the REST API directly.

### Scopes

The extension asks for these scopes. Every call runs as the signed-in person, so it can never do more than their own Azure DevOps permissions allow.

| Scope                      | Name                            | Why                                                                                                                                                  |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vso.work`                 | Work items (read)               | To read processes and work item type layouts: which process a project uses, and which controls are on its forms.                                     |
| `vso.work_write`           | Work items (read and write)     | To update a control’s Options when you assign it a configuration, move it or clean it up. Azure DevOps still checks the **Edit process** permission. |
| `vso.extension.data_write` | Extension data (read and write) | To read and save configurations, their credentials and the security policy.                                                                          |

4.0 asks for the same scopes as 3.0, so updating from 3.x needs no new approval. Updating from 1.x does: Azure DevOps doesn’t install the update until an administrator approves the extension data scope in **Organization settings › Extensions**. None of these scopes are high-privilege scopes in Azure DevOps’ list.

## Moving from 3.x

Controls set up with 1.x to 3.x keep their API settings on the process editor’s **Options** tab, and they keep working until you move them: their own settings, 3.0 saved configurations, and their password or token. The Options tab no longer shows those settings, so they can’t be changed there anymore.

1. Open **Organization settings › Extensions › REST Picklist**. A banner says how many controls “still keep their API settings in the process editor”.
2. Choose a process that has some, and select **Review and move**, or **Move** on one of its controls. You need **Edit process** permission on that process.
3. The dialog shows the plan: the configurations it creates, or the existing ones it reuses, the controls that will use each one, and the secrets you’ll need to enter again. Select **Move N controls**.

What moving does:

- Controls with the same settings and the same secret share one configuration. It’s named after the 3.0 saved configuration they used, or else the control’s label or field, with the work item type added when the name is taken. An existing configuration with exactly the same settings is reused.
- **Allow multiple values**, **Load the list when the work item opens** and **Mark as required when empty** were set on each control in 3.0. They’re part of the configuration now, so controls that differ there get separate configurations.
- The password, token or API key moves into the configuration’s credentials when Azure DevOps shows it to the page. When it’s hidden, the dialog says “Needs the … again”. Enter it in the configuration right after moving: until then, those forms say the secret isn’t set.
- When a control’s layout doesn’t show whether it signs in, it moves without signing in, with a note. If it did sign in, choose its sign-in method and enter the secret after moving.
- Finally, each control’s Options are set to just its field and configuration name, which removes the old settings and password from the process. A control that can’t be updated keeps its old settings and still works. Controls that can’t move yet, such as ones whose 3.0 saved configuration no longer exists, are listed with the reason.

Also:

- **Move a control before you change it in the process editor.** The Options tab doesn’t show the old settings anymore, so saving the control there may drop them.
- **Clean up old settings** appears on a control that already uses a configuration but still stores old settings, and removes them.
- **Files** exported from 3.0’s Saved configurations tab import into 4.0. They never contained credentials, so enter those in each configuration.
- **The security policy** keeps applying. If it allowed all four 3.0 sign-in methods, OAuth 2.0 is allowed too; otherwise, allow it on the Security policy tab when you need it. The 3.0 option **Allow saved configurations** has no switch anymore; its saved value still applies to controls that haven’t moved.

### From 1.x

- **Lists load when they’re opened**, so forms open faster. To load a list with the form, as 1.x did, turn on **Load the list when the work item opens** in its configuration.
- **“Hide native Field label” is gone.** It had no effect; set the label on the control’s **Layout** tab instead.
- **Clearing a value empties the fields filled from it**, instead of leaving the old copied values behind.
- **Approve the extension data scope.** Azure DevOps keeps 1.x until an administrator approves it in **Organization settings › Extensions**.
- Settings with `Bearer` in the user name keep working, and move as Bearer token sign-in.

## Security policy

**Organization settings › Extensions › REST Picklist › Security policy** sets rules for every REST Picklist control in the organization and for the setup page’s tests. The policy can only tighten the protections built into the control, never loosen them. Only Project Collection Administrators can change it, unless Azure DevOps refuses the permission check (see “Permissions”); everyone else sees it written out as text.

![The Security policy tab: HTTPS always on, localhost for testing, private network blocking, allowed hosts, sign-in methods and limits](img/screenshots/setup-policy.png)

| Option                                        | Default               | What it does                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS required                                | Always on             | Built in; it can’t be turned off.                                                                                                                                                                                                                                                                                                                                                                                          |
| Allow `http://localhost` for testing          | Off                   | Lets controls call `http://localhost`, `http://127.0.0.1` and `http://[::1]`, for people testing an API on their own computer. These addresses are then allowed even if the host list or the private network block would stop them.                                                                                                                                                                                        |
| Block private network addresses (recommended) | Off                   | Blocks names and addresses that only exist inside a network: `localhost`, single-label names like `intranet`, names ending in `.local`, `.localhost`, `.internal` or `.home.arpa`, and private, loopback, link-local and shared IPv4 and IPv6 addresses (10.x.x.x, 172.16–31.x.x, 192.168.x.x, 127.x.x.x, 169.254.x.x, 100.64–127.x.x, `fc00::/7`, `fe80::/10`…). Off by default so existing intranet setups keep working. |
| Allowed hosts                                 | Empty: any HTTPS host | One host name per line. `*.contoso.com` allows every subdomain of contoso.com, at any depth, but not contoso.com itself. No `https://`, paths or ports. It applies to API endpoints and OAuth 2.0 token URLs.                                                                                                                                                                                                              |
| Sign-in methods                               | All five allowed      | Controls can only use the checked methods. Uncheck None to require signing in.                                                                                                                                                                                                                                                                                                                                             |
| Maximum pages                                 | 100                   | The most pages any control may load (1–100). Configurations with a lower setting keep it.                                                                                                                                                                                                                                                                                                                                  |
| Maximum items                                 | 50,000                | The most items any control may load (1–50,000).                                                                                                                                                                                                                                                                                                                                                                            |
| Timeout                                       | 120 seconds           | The longest any control waits for a response (5–120 seconds).                                                                                                                                                                                                                                                                                                                                                              |

- Controls pick up a saved policy within five minutes. The page shows who changed it last, and when.
- When **Allowed hosts** or **Block private network addresses** are on, requests don’t follow redirects, because the browser would contact a redirect’s target before it can be checked. Requests that sign in never follow redirects either. In both cases, endpoints must use their final address.
- The private network block checks the host name or address written in the URL. A public host name that resolves to a private address (through DNS) can’t be detected in the browser. To limit controls to known APIs, use **Allowed hosts**.
- If the policy can’t be read, the built-in rules apply.

**What the policy is, and isn’t.** The policy is stored in this extension’s data for the organization. Azure DevOps lets any member of the organization write extension data through its REST API, so the policy is a guard rail that keeps process editors to the endpoints and sign-in methods you allow, not a hard security boundary. The built-in protections below always apply, whatever the policy says.

## Security model

REST Picklist runs entirely in the browser, without a server of its own. That keeps it simple to run, and it also sets limits worth knowing:

- **Credentials reach the browser.** The API is called from the browser of the person using the form, so a configuration’s credential goes to everyone who opens a work item that uses it. **Anyone who can open such a work item can read the credential with browser developer tools.** With OAuth 2.0 that’s the client secret or private key, not just the token. Use read-only credentials limited to the API, never a personal access token or an account with broad rights.
- **Credentials are hidden, not encrypted.** Write-only means the page never shows a saved credential again. Credentials are stored in this extension’s data, which any member of the organization can read through the Azure DevOps REST API.
- **Edit rights are a guard rail.** See “Permissions”.
- **Credentials only go where they were saved for.** Changing where a configuration sends its credential means entering the credential again, and forms refuse to send it anywhere else.

These protections are built in and always apply:

- Only HTTPS endpoints and token URLs are called. `http://localhost` works only when the security policy allows it for testing.
- Cookies are never sent to the endpoint or the token URL.
- Work item values can go in the path or query string but can’t change the endpoint’s host. A user name or password written in a URL is refused. Field values can’t be used in the access token URL.
- Requests that sign in don’t follow redirects, so credentials are never forwarded to another address. Token requests never follow them either. Other requests are only redirected within the same site, or not at all when the policy restricts hosts.
- Next-page links must stay on the endpoint’s own site (the same scheme, host and port) and pass the security policy. Otherwise paging stops, the items loaded so far are shown, and nothing is sent to the link.
- Responses are shown as plain text and are never interpreted as HTML. Values written to multi-line (HTML) fields are escaped.
- Credentials and access tokens are never written to browser storage, logs, error messages or exported files. Tokens live in memory only.
- Every request has a time limit, and every list has an item limit.
- Nothing is sent to the publisher, and there’s no telemetry.

## CORS

The API, and for OAuth 2.0 the token URL, are called from the browser, so they must allow requests from the extension’s origin, `https://oscararguedasbarboza.gallerycdn.vsassets.io`:

- Answer with `Access-Control-Allow-Origin` for that origin.
- When a request signs in with a header (Basic, Bearer token, API key and OAuth 2.0 calls to the API, and **Send as Basic Auth header** to the token URL), the browser first sends a preflight (`OPTIONS`) request. Allow `Authorization`, or the API key header, in `Access-Control-Allow-Headers`.
- For paging with a `Link` header, also list `Link` in `Access-Control-Expose-Headers`, or the browser hides it.
- Cookies are never sent, so `Access-Control-Allow-Credentials` isn’t needed.

The setup page shows the exact origin when a test request is blocked. Azure DevOps REST APIs don’t need any of this.

## FAQ

**Can I use Microsoft Entra ID, or Microsoft Graph?**
Not with OAuth 2.0 here. Entra refuses client credentials sent from a browser, and the extension deploys nothing that could request the token elsewhere. See “Microsoft Entra ID” above.

**Why can’t I see a credential I saved?**
Credentials are write-only. If you’re not sure it’s right, replace it. For a certificate, the thumbprint shows which one is saved.

**Who can read the credentials?**
Anyone who opens a work item that uses the configuration, with browser developer tools, and any member of the organization who reads the extension’s data through the REST API. Use read-only credentials limited to the API.

**A control says “API configuration has moved”.**
Its **Configuration name** is empty, and it has no settings from before 4.0. Enter a name on its **Options** tab, or assign a configuration under **Controls in this process**.

**A control says no configuration with its name is shared with its process.**
Check the name on the control’s **Options** tab, or share the configuration with that process. The message lists the names that are available.

**A control says “This configuration’s address changed after its secret was saved.”**
Someone changed where the configuration sends its credential. Enter the credential again in **Credentials**.

**I changed a configuration, but a form still uses the old settings.**
Each browser tab keeps the list of configurations for up to five minutes.

**Can several processes use one configuration?**
Yes. Use **Share…** in its menu, or **Add process** under **Shared with** in the editor. You need **Edit process** permission on the process you add.

**Why can’t I change a configuration?**
You need **Edit process** permission on one of the processes it’s shared with, or to be a Project Collection Administrator. The page says why next to the process name and in the editor. If it says your permissions couldn’t be checked, select **Try again**.

**Does it work with Azure DevOps Server?**
No, only with Azure DevOps Services.

**How do I remove credentials for good?**
Delete their configurations on the setup page, or remove the credential in **Credentials**. Do it before you uninstall the extension.

## Support, privacy and license

- **Support:** open an issue at https://github.com/OscarArguedasB/RestDataMappingPicklist/issues. The [support policy](https://github.com/OscarArguedasB/RestDataMappingPicklist/blob/main/SUPPORT.md) says what to include and what’s supported.
- **Security:** report vulnerabilities privately as described in the [security policy](https://github.com/OscarArguedasB/RestDataMappingPicklist/blob/main/SECURITY.md).
- **Privacy:** the extension collects no telemetry and sends nothing to the publisher. See the [privacy policy](https://github.com/OscarArguedasB/RestDataMappingPicklist/blob/main/PRIVACY.md).
- **License:** Copyright (c) 2026 Oscar Arguedas Barboza. All rights reserved. You may install the extension from the Visual Studio Marketplace and use it free of charge; see the [license](https://github.com/OscarArguedasB/RestDataMappingPicklist/blob/main/LICENSE). The open source components it includes are listed in the [third-party notices](https://github.com/OscarArguedasB/RestDataMappingPicklist/blob/main/THIRD-PARTY-NOTICES.md).
