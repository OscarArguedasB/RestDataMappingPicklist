/**
 * Copies text. The async Clipboard API can be blocked inside the Azure DevOps iframe, so this
 * falls back to a temporary text area and the legacy copy command.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      // oxlint-disable-next-line typescript/no-deprecated -- the only fallback inside restricted iframes
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}
