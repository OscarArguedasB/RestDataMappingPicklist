/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_AUTHENTICATION_LABELS } from '../core/config';
import type { SecurityPolicy } from '../core/policy';
import { DEFAULT_POLICY, parsePolicy } from '../core/policy';
import { ConnectCard } from './ConnectCard';
import { OAUTH_NOTICE, TOKEN_PARAMETERS_KEY } from './OAuthFields';
import type { Draft } from './settings';
import { EMPTY_DRAFT, draftToSettings, validateDraft } from './settings';

vi.mock('azure-devops-extension-sdk', () => ({}));

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(cleanup);

/** The exact words the notice must keep (a product decision). */
const NOTICE_TEXT =
  'OAuth 2.0 uses the app registration’s application permissions (client credentials) to get the token. It doesn’t use delegated permissions or a sign-in page, and nothing extra needs to be deployed. The token is requested from this browser, so the token URL must accept requests from Azure DevOps (CORS). Microsoft Entra ID refuses client credentials sent from a browser, so Entra app registrations won’t work.';

interface Seen {
  draft: Draft;
  validity: Map<string, boolean>;
}

/** The Connect card with its draft held like the editor holds it. */
function Harness(props: {
  initial: Partial<Draft>;
  policy?: SecurityPolicy;
  onDraft: (draft: Draft) => void;
  onValidityChange: (key: string, valid: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT, ...props.initial });
  const policy = props.policy ?? DEFAULT_POLICY;
  const { onDraft } = props;
  useEffect(() => {
    onDraft(draft);
  });
  return (
    <ConnectCard
      draft={draft}
      issues={validateDraft(draft, policy)}
      policy={policy}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onValidityChange={props.onValidityChange}
      invalid={new Set()}
      reveal={0}
    />
  );
}

function renderConnect(initial: Partial<Draft> = {}, policy?: SecurityPolicy) {
  const seen: Seen = { draft: EMPTY_DRAFT, validity: new Map() };
  render(
    <Harness
      initial={{ url: 'https://api.contoso.com/items', ...initial }}
      policy={policy}
      onDraft={(draft) => {
        seen.draft = draft;
      }}
      onValidityChange={(key, valid) => seen.validity.set(key, valid)}
    />
  );
  return seen;
}

function notice(): HTMLElement | null {
  return screen.queryByRole('note');
}

describe('the sign-in method', () => {
  it('offers all five methods, as joined buttons that become a list when narrow', () => {
    renderConnect();
    const methods = screen.getByRole('group', { name: 'Sign-in method' });
    expect(
      within(methods)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value'))
    ).toEqual(['none', 'basic', 'bearer', 'apiKey', 'oauth2']);
    expect(within(methods).getByRole('radio', { name: 'None' })).toHaveProperty('checked', true);
    expect(methods.classList.contains('cf-segmented--adaptive')).toBe(true);
  });

  it('disables the methods the security policy doesn’t allow, with the reason', () => {
    renderConnect({}, parsePolicy({ allowedAuthMethods: ['none', 'bearer'] }));
    const methods = screen.getByRole('group', { name: 'Sign-in method' });
    expect(within(methods).getByRole('radio', { name: 'Basic' })).toHaveProperty('disabled', true);
    expect(within(methods).getByRole('radio', { name: 'OAuth 2.0' })).toHaveProperty(
      'disabled',
      true
    );
    expect(within(methods).getByRole('radio', { name: 'Bearer token' })).toHaveProperty(
      'disabled',
      false
    );
    expect(
      screen.getByText(
        'Your organization’s security policy doesn’t allow Basic, API key or OAuth 2.0.'
      )
    ).toBeTruthy();
    expect(methods.getAttribute('aria-describedby')).toBeTruthy();
  });
});

describe('the OAuth 2.0 notice', () => {
  it('shows only with OAuth 2.0, word for word, under the method choice', async () => {
    const user = userEvent.setup();
    renderConnect({ authMethod: 'basic' });
    expect(notice()).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'OAuth 2.0' }));
    const shown = notice();
    if (!shown) {
      throw new Error('No notice');
    }
    const paragraphs = [...shown.querySelectorAll('p')].map((paragraph) => paragraph.textContent);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs.join(' ')).toBe(NOTICE_TEXT);
    expect(OAUTH_NOTICE.join(' ')).toBe(NOTICE_TEXT);
    // The first sentence is bold, so it doesn't rely on the red alone.
    expect(shown.querySelector('strong')?.textContent).toBe(OAUTH_NOTICE[0]);
    expect(shown.querySelector('svg')).toBeTruthy();
    // Right under the method choice, never behind a toggle or a dismiss button.
    expect(
      shown.previousElementSibling?.contains(screen.getByRole('group', { name: 'Sign-in method' }))
    ).toBe(true);
    expect(within(shown).queryByRole('button')).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'API key' }));
    expect(notice()).toBeNull();
  });
});

// Typing whole addresses key by key re-renders the form on every keystroke, which is slow in
// jsdom and slower while the full suite runs in parallel.
describe('OAuth 2.0 settings', { timeout: 15_000 }, () => {
  it('follow Postman’s order, with the grant type as text', async () => {
    const user = userEvent.setup();
    const seen = renderConnect({ authMethod: 'oauth2' });
    expect(screen.getByText('Grant type', { selector: 'dt' }).nextElementSibling?.textContent).toBe(
      'Client credentials (application permissions)'
    );
    expect(screen.queryByRole('textbox', { name: 'Grant type' })).toBeNull();
    const tokenUrl = screen.getByLabelText('Access token URL');
    expect(tokenUrl.getAttribute('placeholder')).toBe('https://auth.example.com/oauth2/token');
    expect(tokenUrl.getAttribute('aria-required')).toBe('true');
    expect(screen.getByLabelText('Scope (optional)').getAttribute('placeholder')).toBe(
      'api://…/.default'
    );
    await user.type(tokenUrl, 'https://auth.contoso.com/oauth2/token');
    await user.type(screen.getByLabelText('Client ID'), 'picklist');
    await user.type(screen.getByLabelText('Scope (optional)'), 'api://picklist/.default');

    const credential = screen.getByRole('group', { name: 'Credential' });
    expect(within(credential).getByRole('radio', { name: /^Client secret/ })).toHaveProperty(
      'checked',
      true
    );
    const authentication = screen.getByRole('group', { name: 'Client authentication' });
    expect(
      within(authentication)
        .getAllByRole('radio')
        .map((radio) => radio.parentElement?.textContent)
    ).toEqual([CLIENT_AUTHENTICATION_LABELS.basic, CLIENT_AUTHENTICATION_LABELS.body]);
    expect(authentication.textContent).toContain('send the credentials in the body');
    await user.click(
      within(authentication).getByRole('radio', { name: 'Send client credentials in body' })
    );
    expect(JSON.parse(draftToSettings(seen.draft).OAuthSettings ?? '')).toEqual({
      tokenUrl: 'https://auth.contoso.com/oauth2/token',
      clientId: 'picklist',
      scope: 'api://picklist/.default',
      clientAuthentication: 'body',
    });

    // A certificate always signs a JWT: no choice to make, and the assertion's audience appears.
    await user.click(within(credential).getByRole('radio', { name: /^Certificate/ }));
    expect(screen.queryByRole('group', { name: 'Client authentication' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Advanced/ }));
    await user.type(
      screen.getByLabelText('Assertion audience (optional)'),
      'https://auth.contoso.com'
    );
    expect(JSON.parse(draftToSettings(seen.draft).OAuthSettings ?? '')).toMatchObject({
      clientAuthentication: 'privateKeyJwt',
      assertionAudience: 'https://auth.contoso.com',
    });
  });

  it('marks a Microsoft Entra token URL under the field, in words', async () => {
    const user = userEvent.setup();
    renderConnect({ authMethod: 'oauth2' });
    const tokenUrl = screen.getByLabelText('Access token URL');
    await user.type(tokenUrl, 'https://login.microsoftonline.com/contoso/oauth2/v2.0/token');
    expect(
      screen.getByText(
        'Microsoft Entra ID refuses client credentials sent from a browser, so this token URL won’t work. Use a token service that accepts requests from Azure DevOps.'
      )
    ).toBeTruthy();
    expect(tokenUrl.getAttribute('aria-invalid')).toBe('true');
    // The red notice describes the OAuth 2.0 choice, so it's heard with it and not skipped.
    const redNotice = screen.getByRole('note');
    expect(screen.getByRole('radio', { name: 'OAuth 2.0' }).getAttribute('aria-describedby')).toBe(
      redNotice.id
    );
    expect(redNotice.id).not.toBe('');
    expect(
      screen.getByRole('radio', { name: 'Basic' }).getAttribute('aria-describedby')
    ).toBeNull();
    expect(tokenUrl.getAttribute('aria-describedby')).toContain('issue');
  });

  it('checks each extra token parameter’s name, and sends only the ones that can be', async () => {
    const user = userEvent.setup();
    const seen = renderConnect({ authMethod: 'oauth2' });
    const advanced = screen.getByRole('button', { name: /^Advanced/ });
    expect(advanced.textContent).toContain('Nothing extra');
    await user.click(advanced);
    await user.click(screen.getByRole('button', { name: 'Add parameter' }));
    const name = screen.getByLabelText('Name of parameter 1');
    await user.type(name, 'client_secret');
    await user.type(screen.getByLabelText('Value of parameter 1'), 'x');
    expect(
      screen.getByText(
        '“client_secret” can’t be an extra token parameter. REST Picklist sends the secret itself.'
      )
    ).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(seen.validity.get(TOKEN_PARAMETERS_KEY)).toBe(false);
    expect(seen.draft.oauth.extraParams).toEqual({});

    await user.clear(name);
    await user.type(name, 'tenant');
    expect(seen.validity.get(TOKEN_PARAMETERS_KEY)).toBe(true);
    expect(seen.draft.oauth.extraParams).toEqual({ tenant: 'x' });
    expect(advanced.textContent).toContain('1 extra parameter');

    await user.click(screen.getByRole('button', { name: 'Add parameter' }));
    await user.type(screen.getByLabelText('Name of parameter 2'), 'tenant');
    expect(
      screen.getByText('“tenant” is listed twice in the extra token parameters.')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove parameter 2' }));
    expect(seen.validity.get(TOKEN_PARAMETERS_KEY)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Remove parameter 1' }));
    expect(seen.draft.oauth.extraParams).toEqual({});
  });
});
