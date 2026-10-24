/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EC_P256,
  PASSWORD,
  PFX,
  RSA_2048,
  fromBase64,
  pem,
} from '../core/__fixtures__/credentials';
import type { SecretKind, SecretSummary } from '../core/secrets';
import type { CredentialDraft } from './CredentialsCard';
import { CredentialsCard, EMPTY_CREDENTIALS, signingKeyFor } from './CredentialsCard';
import { ReadOnlyContext } from './ui';

vi.mock('azure-devops-extension-sdk', () => ({}));

afterEach(cleanup);

const NOW = new Date('2026-10-22T12:00:00.000Z');

/** What the card's owner (the editor) keeps, so tests can look at it. */
interface Seen {
  secret: string;
  credentials: CredentialDraft;
}

/** The card with its state held like the editor holds it. */
function Harness(props: {
  kind: SecretKind | null;
  stored?: SecretSummary | null;
  destination?: string | null;
  initial?: Partial<CredentialDraft>;
  /** Told what the card's owner holds after every change. */
  onState: (state: Seen) => void;
  onRemove?: () => void;
  now?: Date;
}) {
  const [secret, setSecret] = useState('');
  const [credentials, setCredentials] = useState<CredentialDraft>({
    ...EMPTY_CREDENTIALS,
    ...props.initial,
  });
  const { onState } = props;
  useEffect(() => {
    onState({ secret, credentials });
  });
  return (
    <CredentialsCard
      kind={props.kind}
      stored={props.stored ?? null}
      secret={secret}
      onSecretChange={setSecret}
      credentials={credentials}
      onCredentialsChange={(patch) => setCredentials((current) => ({ ...current, ...patch }))}
      onRemove={props.onRemove ?? (() => undefined)}
      issue={null}
      keyIdIssue={null}
      destination={props.destination ?? 'https://auth.contoso.com'}
      methodLabel='OAuth 2.0'
      headingId='credentials-heading'
      now={() => props.now ?? NOW}
    />
  );
}

function renderCard(props: Omit<Parameters<typeof Harness>[0], 'onState'>) {
  const seen: Seen = { secret: '', credentials: EMPTY_CREDENTIALS };
  render(<Harness {...props} onState={(state) => Object.assign(seen, state)} />);
  return seen;
}

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Credentials' });
}

/**
 * Waits for text the card shows once a file is read. Reading a .pfx file runs thousands of
 * hashing rounds, which takes a while when every test file runs at once.
 */
function findInCard(text: string): Promise<HTMLElement> {
  return within(card()).findByText(text, {}, { timeout: 15_000 });
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Certificate or key file');
}

function file(name: string, content: string | Uint8Array<ArrayBuffer>): File {
  return new File([content], name);
}

/** The value next to a label in a list of details, like Subject. */
function detail(container: HTMLElement, label: string): string | null | undefined {
  return within(container).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
}

const PEM_KEY = pem('PRIVATE KEY', EC_P256.pkcs8);
const PEM_CERTIFICATE = pem('CERTIFICATE', EC_P256.certificate);

describe('secrets', () => {
  it('starts empty and stays write-only: typed here, never filled in', async () => {
    const user = userEvent.setup();
    const seen = renderCard({ kind: 'clientSecret' });
    expect(within(card()).getByText('Not set')).toBeTruthy();
    expect(within(card()).getByText('Sent only to auth.contoso.com.')).toBeTruthy();
    const input = within(card()).getByLabelText('Client secret');
    expect(input).toHaveProperty('type', 'password');
    expect(input).toHaveProperty('value', '');
    // Kept from password managers, which would keep (and sync) a copy of it.
    expect(input.getAttribute('autocomplete')).toBe('off');
    for (const optOut of ['data-lpignore', 'data-1p-ignore', 'data-bwignore']) {
      expect(input.getAttribute(optOut)).toBe('true');
    }
    expect(input.closest('form')).toBeNull();
    await user.type(input, 'p@ss:word+1');
    await vi.waitFor(() => expect(seen.secret).toBe('p@ss:word+1'));
    expect(
      within(card()).getByText('Saved when you save the configuration, then never shown.')
    ).toBeTruthy();
    expect(
      within(card()).getByText(
        'Hidden on every screen, but not encrypted: any member of your organization can read it through the Azure DevOps REST API, and anyone who opens a work item that uses it can read it with browser developer tools. Use a read-only credential limited to this API.'
      )
    ).toBeTruthy();
  });

  it('describes a saved secret without showing it, with Replace and Remove', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn<() => void>();
    const seen = renderCard({
      kind: 'clientSecret',
      stored: {
        kind: 'clientSecret',
        boundOrigin: 'https://auth.contoso.com',
        updatedBy: 'Ana Díaz',
        updatedAt: '2026-10-22T12:00:00.000Z',
      },
      onRemove,
    });
    expect(within(card()).getByText('Set · changed by Ana Díaz on 22 Oct 2026')).toBeTruthy();
    expect(within(card()).queryByLabelText('Client secret')).toBeNull();
    await user.click(within(card()).getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    await user.click(within(card()).getByRole('button', { name: 'Replace' }));
    await vi.waitFor(() => expect(seen.credentials.replacing).toBe(true));
    expect(document.activeElement).toBe(within(card()).getByLabelText('New client secret'));
  });

  it('says what happens to a saved secret the sign-in can no longer use', () => {
    renderCard({
      kind: 'token',
      stored: { kind: 'password', boundOrigin: 'https://api.contoso.com' },
      destination: 'https://api.contoso.com',
    });
    expect(
      within(card()).getByText(
        'The saved password can’t be used with OAuth 2.0, so it’s removed when you save.'
      )
    ).toBeTruthy();
    expect(within(card()).getByLabelText('Token')).toBeTruthy();
  });

  it('lets a removal be undone before saving', async () => {
    const user = userEvent.setup();
    const seen = renderCard({
      kind: 'apiKey',
      stored: { kind: 'apiKey', boundOrigin: 'https://auth.contoso.com' },
      initial: { removing: true },
    });
    expect(within(card()).getByText(/^Removed when you save\./)).toBeTruthy();
    await user.click(within(card()).getByRole('button', { name: 'Undo' }));
    await vi.waitFor(() => expect(seen.credentials.removing).toBe(false));
    expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'Replace' }));
  });

  it('shows only the description to people who may view but not change it', () => {
    render(
      <ReadOnlyContext value>
        <Harness kind='password' onState={() => undefined} />
      </ReadOnlyContext>
    );
    expect(within(card()).getByText('Not set')).toBeTruthy();
    expect(within(card()).queryByRole('textbox')).toBeNull();
    expect(within(card()).queryByLabelText('Password')).toBeNull();
    expect(within(card()).queryByRole('button')).toBeNull();
  });
});

describe('certificates and keys', { timeout: 30_000 }, () => {
  it('describes a saved certificate: names, dates and thumbprints, never the key', async () => {
    const user = userEvent.setup();
    renderCard({
      kind: 'signingKey',
      stored: {
        kind: 'signingKey',
        boundOrigin: 'https://auth.contoso.com',
        algorithm: 'ES256',
        certificate: EC_P256.info,
        updatedBy: 'Ana Díaz',
        updatedAt: '2026-10-22T12:00:00.000Z',
      },
      now: new Date('2026-11-15T12:00:00.000Z'),
    });
    const details = card();
    expect(detail(details, 'Subject')).toBe('CN=picklist-ec-256,O=Contoso');
    expect(detail(details, 'Issuer')).toBe('CN=picklist-ec-256,O=Contoso');
    expect(detail(details, 'Valid until')).toBe('1 Dec 2026');
    expect(within(details).getByText(EC_P256.info.sha1Thumbprint)).toBeTruthy();
    expect(within(details).getByRole('button', { name: 'Copy SHA-1 thumbprint' })).toBeTruthy();
    const sha256 = within(details).getByText('SHA-256 thumbprint').closest('details');
    expect(sha256?.open).toBe(false);
    expect(sha256?.textContent).toContain(EC_P256.info.sha256Thumbprint);
    expect(within(details).getByText('ES256')).toBeTruthy();
    expect(
      within(details).getByText('The certificate expires on 1 Dec 2026 (in 15 days).')
    ).toBeTruthy();
    await user.click(within(details).getByRole('button', { name: 'Replace' }));
    expect(
      document.activeElement ===
        within(details).getByRole('button', { name: 'Choose a certificate file…' })
    ).toBe(true);
  });

  it('reads a .pfx file once its password is entered, and explains a wrong one', async () => {
    const user = userEvent.setup();
    const seen = renderCard({ kind: 'signingKey' });
    await user.upload(fileInput(), file('client.pfx', fromBase64(PFX.modern)));
    expect(
      await findInCard('“client.pfx” is protected by a password. Enter it and try again.')
    ).toBeTruthy();
    const password = within(card()).getByLabelText('File password');
    expect(password).toHaveProperty('type', 'password');

    await user.type(password, 'not-it');
    await user.click(within(card()).getByRole('button', { name: 'Unlock' }));
    expect(await findInCard('The password for “client.pfx” is wrong.')).toBeTruthy();
    expect(seen.credentials.chosenKey).toBeNull();

    await user.clear(password);
    await user.type(password, `${PASSWORD}{Enter}`);
    expect(await findInCard('From client.pfx · RSA 2048-bit key')).toBeTruthy();
    expect(within(card()).getByText(RSA_2048.info.sha1Thumbprint)).toBeTruthy();
    expect(
      within(card()).getByText('Not saved yet: it’s saved when you save the configuration.')
    ).toBeTruthy();
    // The file and its password are gone once the key is read.
    expect(within(card()).queryByLabelText('File password')).toBeNull();
    const key = await vi.waitFor(() => {
      const read = signingKeyFor(seen.credentials);
      expect(read?.algorithm).toBe('RS256');
      return read;
    });
    expect(key?.x5t).toBeTruthy();
    expect(document.body.textContent).not.toContain(key?.pkcs8.slice(0, 32) ?? '?');

    await user.selectOptions(within(card()).getByLabelText('Signing algorithm'), 'PS256');
    await vi.waitFor(() => expect(signingKeyFor(seen.credentials)?.algorithm).toBe('PS256'));
  });

  it('reads a key and its certificate from two files, chosen one after the other', async () => {
    const user = userEvent.setup();
    const seen = renderCard({ kind: 'signingKey' });
    await user.upload(fileInput(), file('client.crt', PEM_CERTIFICATE));
    expect(
      await findInCard(
        'There’s a certificate but no private key. Add the private key, or a .pfx file that includes it.'
      )
    ).toBeTruthy();
    expect(within(card()).getByRole('list', { name: 'Chosen files' }).textContent).toContain(
      'client.crt'
    );
    await user.upload(fileInput(), file('client.key', PEM_KEY));
    expect(await findInCard('From client.crt, client.key · EC key on P-256')).toBeTruthy();
    expect(within(card()).getByText('Signature: ES256.')).toBeTruthy();
    expect(detail(card(), 'Subject')).toBe('CN=picklist-ec-256,O=Contoso');
    await vi.waitFor(() =>
      expect(seen.credentials.chosenKey?.parsed.certificate?.sha1Thumbprint).toBe(
        EC_P256.info.sha1Thumbprint
      )
    );
  });

  it('takes a key without a certificate, with a key ID', async () => {
    const user = userEvent.setup();
    const seen = renderCard({ kind: 'signingKey' });
    await user.click(within(card()).getByLabelText('I have a key without a certificate'));
    expect(within(card()).getByRole('button', { name: 'Choose a key file…' })).toBeTruthy();
    await user.type(within(card()).getByLabelText('Key ID (optional)'), 'picklist-2026');
    await user.upload(fileInput(), file('client.key', pem('PRIVATE KEY', RSA_2048.pkcs8)));
    expect(await findInCard('From client.key · RSA 2048-bit key · no certificate')).toBeTruthy();
    expect(within(card()).getByLabelText('Key ID (optional)')).toHaveProperty(
      'value',
      'picklist-2026'
    );
    const key = await vi.waitFor(() => {
      const read = signingKeyFor(seen.credentials);
      expect(read?.kid).toBe('picklist-2026');
      return read;
    });
    expect(key?.x5t).toBeUndefined();
  });

  it('reads pasted PEM text instead of a file', async () => {
    const user = userEvent.setup();
    const seen = renderCard({ kind: 'signingKey' });
    await user.click(within(card()).getByRole('button', { name: 'Paste PEM instead' }));
    const text = within(card()).getByLabelText('PEM text');
    expect(document.activeElement).toBe(text);
    await user.click(text);
    await user.paste(`${PEM_KEY}${PEM_CERTIFICATE}`);
    expect(await findInCard('From Pasted text · EC key on P-256')).toBeTruthy();
    await vi.waitFor(() => expect(seen.credentials.chosenKey).not.toBeNull());
    await user.click(within(card()).getByRole('button', { name: 'Choose another file' }));
    await vi.waitFor(() => expect(seen.credentials.chosenKey).toBeNull());
  });

  it('refuses files that aren’t keys or certificates, with the reason', async () => {
    const user = userEvent.setup();
    renderCard({ kind: 'signingKey' });
    await user.upload(fileInput(), file('notes.pem', 'hello'));
    expect(
      await findInCard(
        '“notes.pem” isn’t a key or certificate file. Use PEM, DER (.cer, .crt, .der, .key) or PKCS #12 (.pfx, .p12).'
      )
    ).toBeTruthy();
  });
});
