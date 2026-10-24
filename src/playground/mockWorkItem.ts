import type { WorkItemFieldInfo, WorkItemFormService } from '../devops/formService';

type ChangeListener = (changed: Record<string, unknown>) => void;

/** An in-memory work item that behaves like the Azure DevOps form service. */
export class MockWorkItem implements WorkItemFormService {
  private values: Record<string, unknown>;
  private saved: Record<string, unknown>;
  private readonly fields: WorkItemFieldInfo[];
  private readonly required = new Set<string>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly renderListeners = new Set<() => void>();
  private version = 0;

  constructor(fields: WorkItemFieldInfo[], values: Record<string, unknown>) {
    this.fields = fields;
    this.values = { ...values };
    this.saved = { ...values };
  }

  // --- WorkItemFormService ---

  getFields = async (): Promise<WorkItemFieldInfo[]> => this.fields;

  getFieldValue = async (field: string, options?: { returnOriginalValue: boolean }) =>
    (options?.returnOriginalValue ? this.saved : this.values)[field];

  getFieldValues = async (fields: string[]) =>
    Object.fromEntries(fields.map((field) => [field, this.values[field]]));

  setFieldValues = async (updates: Record<string, unknown>) => {
    this.values = { ...this.values, ...updates };
    this.notify(updates);
    return Object.fromEntries(Object.keys(updates).map((field) => [field, true]));
  };

  getAllowedFieldValues = async (): Promise<unknown[]> => [];

  getInvalidFields = async (): Promise<WorkItemFieldInfo[]> =>
    this.fields.filter(
      (field) => this.required.has(field.referenceName) && !this.values[field.referenceName]
    );

  // --- Playground helpers ---

  readonly subscribe = (listener: () => void) => {
    this.renderListeners.add(listener);
    return () => {
      this.renderListeners.delete(listener);
    };
  };

  readonly getVersion = () => this.version;

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  value(field: string): string {
    const value = this.values[field];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }

  /** The field's display name, as the form shows it above the field. */
  label(field: string): string {
    return this.fields.find((info) => info.referenceName === field)?.name ?? field;
  }

  isDirty(): boolean {
    return Object.keys(this.values).some((field) => this.values[field] !== this.saved[field]);
  }

  setRequired(field: string, required: boolean): void {
    if (required) {
      this.required.add(field);
    } else {
      this.required.delete(field);
    }
  }

  save(): void {
    this.saved = { ...this.values };
    this.bump();
  }

  reset(): void {
    const changed = Object.fromEntries(
      Object.keys(this.values)
        .filter((field) => this.values[field] !== this.saved[field])
        .map((field) => [field, this.saved[field]])
    );
    this.values = { ...this.saved };
    this.notify(changed);
  }

  private notify(changed: Record<string, unknown>): void {
    this.bump();
    // The real form reports changes asynchronously, after the value is stored.
    queueMicrotask(() => {
      for (const listener of this.changeListeners) {
        listener(changed);
      }
    });
  }

  private bump(): void {
    this.version++;
    for (const listener of this.renderListeners) {
      listener();
    }
  }
}
