import { FILE_LIMITS } from '../core/configurations';

/** A file name made from a configuration or process name: “Customers (EMEA)” → customers-emea. */
export function fileNameFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `rest-picklist-${slug || 'configuration'}.json`;
}

/**
 * Offers text as a file download. Returns false when the browser refused, so the caller can offer
 * to copy the text instead (downloads can be blocked inside the Azure DevOps frame).
 */
export function downloadText(fileName: string, content: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Some browsers read the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Reads a picked file as text, refusing anything too large to be a configuration file. */
export async function readConfigurationFile(
  file: Pick<File, 'size' | 'text'>
): Promise<{ text: string; error: string | null }> {
  if (file.size > FILE_LIMITS.maxBytes) {
    return { text: '', error: 'This file is larger than 1 MB.' };
  }
  try {
    return { text: await file.text(), error: null };
  } catch {
    return { text: '', error: 'The file couldn’t be read. Try again.' };
  }
}
