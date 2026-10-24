/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutControl } from '../core/migration';
import { LeftoverInputsError } from '../devops/layout';
import { RenameControlsDialog } from './RenameControlsDialog';
import type { SetupServices } from './services';
import { configuration, fakeServices, layoutControl } from './testUtils';

vi.mock('azure-devops-extension-sdk', () => ({}));

afterEach(cleanup);

const RENAMED = configuration('Customers v2', { aliases: ['Customers v1'] });

// Uses the configuration by its former name, and still saves “Customers” for Epic › Account (3.0).
const HOLDER = layoutControl({
  controlId: 'c-holder',
  label: 'Customer',
  inputs: {
    FieldName: 'Custom.Customer',
    Configuration: 'Customers v1',
    SaveConfiguration: 'true',
    SavedConfigurationName: 'Customers',
    RestServiceAddress: 'https://old.contoso.com/customers',
    RestServicePassword: 'old-password',
  },
});
const DEPENDENT = layoutControl({
  controlId: 'c-account',
  label: 'Account',
  workItemType: { name: 'Epic', referenceName: 'Contoso.Epic' },
  inputs: { FieldName: 'Custom.Account', SavedConfiguration: 'Customers' },
});

function renderDialog(scanned: readonly LayoutControl[], services = fakeServices()) {
  const onUpdated = vi.fn<(control: LayoutControl) => void>();
  render(
    <RenameControlsDialog
      configuration={RENAMED}
      previousName='Customers v1'
      controls={[HOLDER]}
      others={0}
      scanned={scanned}
      services={services}
      onUpdated={onUpdated}
      onClose={() => undefined}
    />
  );
  return { services, onUpdated };
}

describe('RenameControlsDialog', () => {
  it('keeps the 3.0 settings a control saves for others, but never its password', async () => {
    const user = userEvent.setup();
    const { services, onUpdated } = renderDialog([HOLDER, DEPENDENT]);
    await user.click(screen.getByRole('button', { name: 'Update 1 control' }));
    expect(await screen.findByText('Updated 1 of 1 control.')).toBeTruthy();
    expect(vi.mocked(services.updateControlInputs).mock.calls[0]?.[1]).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers v2',
      SaveConfiguration: 'true',
      SavedConfigurationName: 'Customers',
      RestServiceAddress: 'https://old.contoso.com/customers',
    });
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('sends only the field and the name once nobody uses what it saves', async () => {
    const user = userEvent.setup();
    const { services } = renderDialog([HOLDER]);
    await user.click(screen.getByRole('button', { name: 'Update 1 control' }));
    expect(await screen.findByText('Updated 1 of 1 control.')).toBeTruthy();
    expect(vi.mocked(services.updateControlInputs).mock.calls[0]?.[1]).toEqual({
      FieldName: 'Custom.Customer',
      Configuration: 'Customers v2',
    });
  });

  it('says when Azure DevOps kept old settings, and still shows the control as changed', async () => {
    const user = userEvent.setup();
    const services = fakeServices({
      updateControlInputs: vi.fn<SetupServices['updateControlInputs']>(async (control, inputs) => {
        throw new LeftoverInputsError({ ...control, inputs: { ...control.inputs, ...inputs } }, [
          'RestServicePassword',
        ]);
      }),
    });
    const { onUpdated } = renderDialog([HOLDER], services);
    await user.click(screen.getByRole('button', { name: 'Update 1 control' }));
    const dialog = screen.getByRole('dialog');
    expect(
      await within(dialog).findByText(
        'The old settings, including the password, are still stored on this control. Try again, or remove the control from the form and add it again.'
      )
    ).toBeTruthy();
    expect(within(dialog).getByText('Updated 0 of 1 control.')).toBeTruthy();
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({ Configuration: 'Customers v2' }),
      })
    );
  });
});
