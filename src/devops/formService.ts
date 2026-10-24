// The parts of azure-devops-extension-api's work item form service that this extension uses.
// Declared locally so the extension doesn't ship that package (its SDK peer range lags SDK 5).

export const WORK_ITEM_FORM_SERVICE_ID = 'ms.vss-work-web.work-item-form';

export interface WorkItemFieldInfo {
  referenceName: string;
  name: string;
  /** FieldType from azure-devops-extension-api (a number at run time); see core/fieldTypes. */
  type?: number | string;
  isPicklist?: boolean;
  isPicklistSuggested?: boolean;
  readOnly?: boolean;
}

export interface WorkItemValueOptions {
  returnOriginalValue: boolean;
}

export interface WorkItemFormService {
  getFields(): Promise<WorkItemFieldInfo[]>;
  getFieldValue(fieldReferenceName: string, options?: WorkItemValueOptions): Promise<unknown>;
  getFieldValues(
    fieldReferenceNames: string[],
    options?: WorkItemValueOptions
  ): Promise<Record<string, unknown>>;
  setFieldValues(fields: Record<string, unknown>): Promise<Record<string, boolean>>;
  getAllowedFieldValues(fieldReferenceName: string): Promise<unknown[]>;
  getInvalidFields(): Promise<WorkItemFieldInfo[]>;
}

export interface WorkItemChangedArgs {
  id: number;
}

export interface WorkItemLoadedArgs extends WorkItemChangedArgs {
  isNew?: boolean;
  /** Missing on older hosts. */
  isReadOnly?: boolean;
}

export interface WorkItemFieldChangedArgs extends WorkItemChangedArgs {
  changedFields: Record<string, unknown>;
}

/** Notifications the work item form sends to a registered control. */
export interface WorkItemNotificationListener {
  onLoaded(args: WorkItemLoadedArgs): void;
  onFieldChanged(args: WorkItemFieldChangedArgs): void;
  onSaved(args: WorkItemChangedArgs): void;
  onRefreshed(args: WorkItemChangedArgs): void;
  onReset(args: WorkItemChangedArgs): void;
  onUnloaded(args: WorkItemChangedArgs): void;
}
