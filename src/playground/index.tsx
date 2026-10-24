import type { ReactNode } from 'react';
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { InfoIcon } from '../components/Icons';
import { ControlApp } from '../control/ControlApp';
import type { PicklistController } from '../control/controller';
import { SINGLE_LINE_TEXT_LIMIT } from '../core/multi';
import '../styles/theme.css';
import '../styles/control.css';
import '../styles/playground.css';
import { Choices, Group, Segmented, Switch } from './controls';
import { DATASET_SIZES, MOCK_ORIGIN, MOCK_TOKEN_ORIGIN, PAGE_SIZES, REGIONS } from './mockApi';
import type { Scenario, SettingsSource } from './scenario';
import { readScenario, scenarioSearch, sessionKey, usesConfiguration } from './scenario';
import type { Session } from './session';
import { BLOCKING_POLICY, CONFIGURATION, FIELDS, createSession } from './session';
import { applyTheme } from './themes';

const counts = new Intl.NumberFormat('en-US');
const MOCK_HOST = new URL(MOCK_ORIGIN).hostname;
const TOKEN_HOST = new URL(MOCK_TOKEN_ORIGIN).hostname;

function countText(count: number, one: string, many: string): string {
  return `${counts.format(count)} ${count === 1 ? one : many}`;
}

/** “a, b and c”, like the control's own messages. */
function listText(items: readonly string[]): string {
  if (items.length < 2) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

// Built once: the panel re-renders on every scenario change.
const THEME_OPTIONS = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['contrast', 'High contrast'],
] as const;
const LOAD_OPTIONS = [
  ['open', 'When opened'],
  ['form', 'With the form'],
] as const;
const NETWORK_OPTIONS = [
  ['fast', 'Fast'],
  ['slow', 'Slow'],
  ['failing', 'Failing'],
] as const;
const SIZE_OPTIONS = [
  ['small', counts.format(DATASET_SIZES.small)],
  ['large', counts.format(DATASET_SIZES.large)],
] as const;
const PAGING_HINTS = {
  small: `Pages of ${counts.format(PAGE_SIZES.small)} linked by @odata.nextLink`,
  large: `Pages of ${counts.format(PAGE_SIZES.large)} linked by @odata.nextLink`,
} as const;
const ALLOWED_HOSTS = listText(BLOCKING_POLICY.allowedHosts);
const SOURCE_OPTIONS: ReadonlyArray<{ value: SettingsSource; label: string; hint: string }> = [
  {
    value: 'configuration',
    label: 'Configuration',
    hint: `Options name “${CONFIGURATION.name}”, which signs in with an API key`,
  },
  {
    value: 'oauth',
    label: 'OAuth 2.0',
    hint: `A configuration that gets a token from ${TOKEN_HOST} with a client secret`,
  },
  {
    value: 'legacy',
    label: 'Settings on the control',
    hint: 'As before 4.0: everything on the control’s Options tab',
  },
  {
    value: 'moved',
    label: 'No configuration',
    hint: 'Shows where API settings are managed now',
  },
];

function ScenarioPanel(props: { scenario: Scenario; update: (patch: Partial<Scenario>) => void }) {
  const { scenario, update } = props;
  return (
    <aside className='pg-panel' aria-labelledby='pg-panel-title'>
      <div className='pg-brand'>
        <strong>REST Picklist</strong>
        <span>Playground · works offline</span>
      </div>
      <h2 id='pg-panel-title' className='pg-panel__title'>
        Scenario
      </h2>
      <Group title='View'>
        <Segmented
          label='Theme'
          value={scenario.theme}
          options={THEME_OPTIONS}
          onChange={(theme) => update({ theme })}
        />
        <Switch label='Phone' checked={scenario.phone} onChange={(phone) => update({ phone })} />
        <a className='pg-link' href={scenarioSearch({ ...scenario, clean: true })}>
          Clean view for screenshots
        </a>
      </Group>
      <Group title='Set up with'>
        <Choices
          value={scenario.source}
          options={SOURCE_OPTIONS}
          onChange={(source) => update({ source })}
        />
        <Switch
          label='Secret not set'
          hint='The configuration signs in, but no one entered its secret'
          checked={scenario.secretMissing}
          disabled={!usesConfiguration(scenario)}
          onChange={(secretMissing) => update({ secretMissing })}
        />
      </Group>
      <Group title='Settings'>
        <Segmented
          label='Load items'
          value={scenario.load}
          options={LOAD_OPTIONS}
          onChange={(load) => update({ load })}
        />
        <Switch
          label='Multiple values'
          hint='Multi-line field, saved as “A; B; C”'
          checked={scenario.multiple}
          onChange={(multiple) => update({ multiple })}
        />
        <Switch
          nested
          label='Single-line field'
          hint={`Holds up to ${SINGLE_LINE_TEXT_LIMIT} characters`}
          checked={scenario.singleLine}
          disabled={!scenario.multiple}
          onChange={(singleLine) => update({ singleLine })}
        />
        <Switch
          label='Second line'
          hint='Each customer’s email under the name'
          checked={scenario.secondLine}
          onChange={(secondLine) => update({ secondLine })}
        />
        <Switch
          label='Required'
          checked={scenario.required}
          onChange={(required) => update({ required })}
        />
      </Group>
      <Group title='Mock service'>
        <Segmented
          label='Network'
          value={scenario.network}
          options={NETWORK_OPTIONS}
          onChange={(network) => update({ network })}
        />
        <Segmented
          label='Items'
          value={scenario.size}
          options={SIZE_OPTIONS}
          onChange={(size) => update({ size })}
        />
        <Switch
          label='Paging'
          hint={PAGING_HINTS[scenario.size]}
          checked={scenario.paging}
          onChange={(paging) => update({ paging })}
        />
        <Switch
          label='Policy blocks host'
          hint={`${MOCK_HOST} isn’t allowed`}
          checked={scenario.policyBlocks}
          onChange={(policyBlocks) => update({ policyBlocks })}
        />
      </Group>
      <Group title='Work item'>
        <Switch
          label='Required by rule'
          checked={scenario.ruleRequired}
          onChange={(ruleRequired) => update({ ruleRequired })}
        />
        <Switch
          label='Read-only'
          checked={scenario.readOnly}
          onChange={(readOnly) => update({ readOnly })}
        />
        <Switch
          label='Start empty'
          checked={scenario.empty}
          onChange={(empty) => update({ empty, value: null })}
        />
      </Group>
    </aside>
  );
}

function Field(props: { id?: string; label: string; note?: string; children: ReactNode }) {
  const noteId = props.id ? `${props.id}-note` : undefined;
  return (
    <div className='pg-field'>
      <div className='pg-field__label'>
        {props.id ? <label htmlFor={props.id}>{props.label}</label> : <span>{props.label}</span>}
        {props.note ? (
          <span id={noteId} className='pg-field__note'>
            {props.note}
          </span>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

/** A field filled by the picklist's field map; read-only here, it grows with joined values. */
function MappedField(props: { id: string; label: string; value: string }) {
  return (
    <Field id={props.id} label={props.label} note='Copied from the list'>
      <textarea
        id={props.id}
        className='pg-readonly'
        readOnly
        rows={1}
        value={props.value}
        placeholder='Empty'
        aria-describedby={`${props.id}-note`}
      />
    </Field>
  );
}

/** Mimics the iframe Azure DevOps puts around the control, including its resizing. */
function FramedControl({ controller }: { controller: PicklistController }) {
  const [height, setHeight] = useState(36);
  return (
    <div className='pg-frame' style={{ height }}>
      <ControlApp controller={controller} onResize={setHeight} />
    </div>
  );
}

function WorkItemForm({ session }: { session: Session }) {
  const { workItem } = session;
  useSyncExternalStore(workItem.subscribe, workItem.getVersion);
  const dirty = workItem.isDirty();

  return (
    <article className='pg-form' aria-labelledby='pg-form-title'>
      <header className='pg-form__header'>
        <div className='pg-form__heading'>
          <span className='pg-form__type'>Task 42 · {workItem.value(FIELDS.project)}</span>
          <h1 id='pg-form-title' className='pg-form__title'>
            {workItem.value(FIELDS.title)}
          </h1>
        </div>
        <div className='pg-form__actions'>
          {dirty ? <span className='pg-unsaved'>Unsaved changes</span> : null}
          <button type='button' className='pg-button' disabled={!dirty} onClick={session.discard}>
            Discard
          </button>
          <button
            type='button'
            className='pg-button pg-button--primary'
            disabled={!dirty}
            onClick={session.save}
          >
            Save
          </button>
        </div>
      </header>
      <section className='pg-section' aria-labelledby='pg-details-title'>
        <h2 id='pg-details-title' className='pg-section__title'>
          Details
        </h2>
        <div className='pg-grid'>
          <Field id='pg-region' label='Region' note='Reloads the customer list'>
            <select
              id='pg-region'
              className='pg-select'
              aria-describedby='pg-region-note'
              value={workItem.value(FIELDS.region)}
              onChange={(event) =>
                void workItem.setFieldValues({ [FIELDS.region]: event.target.value })
              }
            >
              <option value=''>All regions</option>
              {REGIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </Field>
          <Field label={workItem.label(FIELDS.customer)} note='REST picklist'>
            <FramedControl controller={session.controller} />
          </Field>
          <MappedField
            id='pg-customer-id'
            label={workItem.label(FIELDS.customerId)}
            value={workItem.value(FIELDS.customerId)}
          />
          <MappedField
            id='pg-customer-email'
            label={workItem.label(FIELDS.customerEmail)}
            value={workItem.value(FIELDS.customerEmail)}
          />
        </div>
      </section>
    </article>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <p className='pg-caption'>
      <InfoIcon />
      <span>{children}</span>
    </p>
  );
}

/** Where the settings of a control that names a configuration come from. */
function ConfigurationCaption({ scenario, session }: { scenario: Scenario; session: Session }) {
  const lookup = useSyncExternalStore(session.lookup.subscribe, session.lookup.get);
  let status: string;
  switch (lookup.status) {
    case 'idle':
      status = 'It’s looked up when the work item opens.';
      break;
    case 'pending':
      status = 'Looking it up…';
      break;
    case 'done':
      status = `Found for the project “${lookup.project}”.`;
      break;
    default:
      status = 'The control says why it can’t be used.';
  }
  const signIn =
    scenario.source === 'oauth'
      ? `It gets an access token from ${TOKEN_HOST} with a client secret, then calls ${MOCK_HOST} with the token.`
      : `It signs in to ${MOCK_HOST} with an API key.`;
  const secret = scenario.secretMissing
    ? 'Its secret isn’t set, so the list can’t load.'
    : 'The secret is read when the list first loads, and only kept in memory.';
  return (
    <Caption>
      <strong>Configuration “{scenario.configurationName ?? CONFIGURATION.name}”.</strong> This
      control’s Options only name it; everything else comes from Organization settings › Extensions
      › REST Picklist, where it’s shared with the “{CONFIGURATION.process}” process. {signIn}{' '}
      {secret} {status}
    </Caption>
  );
}

function SourceCaption({ scenario, session }: { scenario: Scenario; session: Session }) {
  switch (scenario.source) {
    case 'legacy':
      return (
        <Caption>
          <strong>Settings on the control.</strong> This control keeps its API settings on its own
          Options tab, as before 4.0, and works as it did until it’s moved to a configuration.
        </Caption>
      );
    case 'moved':
      return (
        <Caption>
          <strong>No configuration.</strong> This control names no configuration and keeps no
          settings of its own, so it calls nothing and says where API settings are managed now. Its
          link opens the setup page’s demo.
        </Caption>
      );
    default:
      return <ConfigurationCaption scenario={scenario} session={session} />;
  }
}

function Captions({ scenario, session }: { scenario: Scenario; session: Session }) {
  return (
    <>
      <SourceCaption scenario={scenario} session={session} />
      {scenario.policyBlocks ? (
        <Caption>
          <strong>Security policy.</strong> The organization only allows {ALLOWED_HOSTS}, so the
          control can’t call {MOCK_HOST}.
        </Caption>
      ) : null}
      {scenario.multiple && scenario.singleLine ? (
        <Caption>
          <strong>Single-line field.</strong> “{session.workItem.label(FIELDS.customer)}” holds up
          to {SINGLE_LINE_TEXT_LIMIT} characters, so only a few more values fit.
        </Caption>
      ) : null}
    </>
  );
}

function Legend({ session }: { session: Session }) {
  const requests = useSyncExternalStore(session.requests.subscribe, session.requests.get);
  const tokens = useSyncExternalStore(session.tokenRequests.subscribe, session.tokenRequests.get);
  return (
    <section className='pg-legend' aria-labelledby='pg-legend-title'>
      <h2 id='pg-legend-title' className='pg-section__title'>
        Border colors
      </h2>
      <ul>
        <li>
          <span className='pg-swatch' data-tone='default' /> Saved value
        </li>
        <li>
          <span className='pg-swatch' data-tone='dirty' /> Changed, not saved yet
        </li>
        <li>
          <span className='pg-swatch' data-tone='error' /> Required and empty
        </li>
      </ul>
      <h2 className='pg-section__title'>Mock service</h2>
      <p className='pg-legend__text'>
        {countText(requests, 'request', 'requests')} since the form opened
        {tokens > 0 ? `, and ${countText(tokens, 'token request', 'token requests')}` : ''}
      </p>
    </section>
  );
}

function replaceUrl(scenario: Scenario): void {
  try {
    window.history.replaceState(null, '', scenarioSearch(scenario) || window.location.pathname);
  } catch {
    // Some browsers don't let file:// pages change their URL; the scenario still applies.
  }
}

function Playground() {
  const [scenario, setScenario] = useState(() => readScenario(window.location.search));
  const [session, setSession] = useState(() => createSession(scenario));

  useEffect(() => applyTheme(scenario.theme), [scenario.theme]);
  useEffect(() => session.start(), [session]);

  const update = (patch: Partial<Scenario>) => {
    const next = { ...scenario, ...patch };
    replaceUrl(next);
    if (sessionKey(next) !== sessionKey(scenario)) {
      setSession(createSession(next));
    }
    setScenario(next);
  };

  const pageClass = scenario.clean ? 'pg-page is-clean' : 'pg-page';
  const stageClass = scenario.phone ? 'pg-stage is-phone' : 'pg-stage';
  return (
    <div className={pageClass}>
      {scenario.clean ? null : <ScenarioPanel scenario={scenario} update={update} />}
      <main className={stageClass}>
        <div className='pg-column'>
          <WorkItemForm key={session.id} session={session} />
          <Captions scenario={scenario} session={session} />
        </div>
        {scenario.clean ? null : <Legend session={session} />}
      </main>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Playground />
    </StrictMode>
  );
}
