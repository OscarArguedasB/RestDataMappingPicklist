/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Callout, CheckboxField, IssueMessage, ReadOnlyContext, SecretField } from './ui';

afterEach(cleanup);

/** The warning triangle's outline, which the error circle doesn't have. */
const TRIANGLE = 'path[d^="M7.13"]';

describe('severity in shapes, not only colors', () => {
  it('marks errors with a circle and warnings with a triangle', () => {
    render(
      <>
        <IssueMessage id='e' issue={{ tone: 'error', message: 'Secret not set' }} />
        <IssueMessage id='w' issue={{ tone: 'warning', message: 'Certificate expires soon' }} />
        <Callout tone='error' title='Couldn’t save.' />
        <Callout tone='warning' title='Some settings were reset.' />
      </>
    );
    expect(document.getElementById('e')?.querySelector(TRIANGLE)).toBeNull();
    expect(document.getElementById('e')?.textContent).toBe('Error: Secret not set');
    expect(document.getElementById('w')?.querySelector(TRIANGLE)).not.toBeNull();
    expect(document.getElementById('w')?.textContent).toBe('Warning: Certificate expires soon');
    const [error, warning] = Array.from(document.querySelectorAll('.cf-callout'));
    expect(error?.querySelector(TRIANGLE)).toBeNull();
    expect(warning?.querySelector(TRIANGLE)).not.toBeNull();
  });
});

describe('SecretField', () => {
  it('names its Show/Hide button for what it does, without a pressed state', async () => {
    const user = userEvent.setup();
    render(<SecretField label='Client secret' value='s3cret' onChange={() => undefined} />);
    const show = screen.getByRole('button', { name: 'Show client secret' });
    // “Hide client secret, pressed” would say the state twice, in opposite words.
    expect(show.getAttribute('aria-pressed')).toBeNull();
    await user.click(show);
    expect(screen.getByRole('button', { name: 'Hide client secret' })).toBeTruthy();
    expect(screen.getByLabelText('Client secret')).toHaveProperty('type', 'text');
  });
});

describe('CheckboxField', () => {
  it('is written out as text where settings can only be viewed', () => {
    render(
      <ReadOnlyContext value>
        <CheckboxField label='Allow more than one value' checked onChange={() => undefined} />
        <CheckboxField label='Required' checked={false} onChange={() => undefined} />
      </ReadOnlyContext>
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Allow more than one value').closest('dl')?.textContent).toBe(
      'Allow more than one valueOn'
    );
    expect(screen.getByText('Required').closest('dl')?.textContent).toBe('RequiredOff');
  });

  it('is a checkbox otherwise', () => {
    render(<CheckboxField label='Required' checked={false} onChange={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: 'Required' })).toHaveProperty('disabled', false);
  });
});
