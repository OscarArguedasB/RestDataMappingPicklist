// Approximations of the variables Azure DevOps sends to extensions for each theme.
export type ThemeName = 'light' | 'dark' | 'contrast';

export const THEMES: Record<ThemeName, Record<string, string>> = {
  light: {
    'background-color': 'rgba(255, 255, 255, 1)',
    'callout-background-color': 'rgba(255, 255, 255, 1)',
    'text-primary-color': 'rgba(0, 0, 0, 0.9)',
    'text-secondary-color': 'rgba(0, 0, 0, 0.55)',
    'text-disabled-color': 'rgba(0, 0, 0, 0.38)',
    'communication-background': 'rgba(0, 120, 212, 1)',
    'communication-foreground': 'rgba(0, 90, 158, 1)',
    'text-on-communication-background': 'rgba(255, 255, 255, 1)',
    'focus-border-color': 'rgba(0, 120, 212, 1)',
    'status-error-text': 'rgba(218, 10, 0, 1)',
    'status-error-foreground': 'rgba(205, 74, 69, 1)',
    'status-warning-text': 'rgba(184, 94, 6, 1)',
    'status-success-foreground': 'rgba(16, 124, 16, 1)',
    'callout-shadow-color': 'rgba(0, 0, 0, 0.132)',
    'callout-shadow-secondary-color': 'rgba(0, 0, 0, 0.108)',
    'pg-page-background': 'rgba(248, 248, 248, 1)',
  },
  dark: {
    'background-color': 'rgba(32, 31, 30, 1)',
    'callout-background-color': 'rgba(45, 44, 43, 1)',
    'text-primary-color': 'rgba(255, 255, 255, 0.87)',
    'text-secondary-color': 'rgba(255, 255, 255, 0.6)',
    'text-disabled-color': 'rgba(255, 255, 255, 0.38)',
    'communication-background': 'rgba(0, 120, 212, 1)',
    'communication-foreground': 'rgba(96, 167, 245, 1)',
    'text-on-communication-background': 'rgba(255, 255, 255, 1)',
    'focus-border-color': 'rgba(96, 167, 245, 1)',
    'status-error-text': 'rgba(241, 112, 123, 1)',
    'status-error-foreground': 'rgba(241, 112, 123, 1)',
    'status-warning-text': 'rgba(255, 185, 80, 1)',
    'status-success-foreground': 'rgba(84, 176, 84, 1)',
    'callout-shadow-color': 'rgba(0, 0, 0, 0.5)',
    'callout-shadow-secondary-color': 'rgba(0, 0, 0, 0.35)',
    'pg-page-background': 'rgba(24, 23, 22, 1)',
  },
  contrast: {
    'background-color': 'rgba(0, 0, 0, 1)',
    'callout-background-color': 'rgba(0, 0, 0, 1)',
    'text-primary-color': 'rgba(255, 255, 255, 1)',
    'text-secondary-color': 'rgba(255, 255, 255, 1)',
    'text-disabled-color': 'rgba(166, 166, 166, 1)',
    'communication-background': 'rgba(26, 235, 255, 1)',
    'communication-foreground': 'rgba(26, 235, 255, 1)',
    'text-on-communication-background': 'rgba(0, 0, 0, 1)',
    'focus-border-color': 'rgba(255, 255, 0, 1)',
    'status-error-text': 'rgba(255, 102, 102, 1)',
    'status-error-foreground': 'rgba(255, 102, 102, 1)',
    'status-warning-text': 'rgba(255, 255, 0, 1)',
    'status-success-foreground': 'rgba(63, 242, 63, 1)',
    'callout-shadow-color': 'rgba(0, 0, 0, 0)',
    'callout-shadow-secondary-color': 'rgba(0, 0, 0, 0)',
    'pg-page-background': 'rgba(0, 0, 0, 1)',
  },
};

/** Writes the theme the same way the DevOps SDK's applyTheme does. */
export function applyTheme(name: ThemeName): void {
  let element = document.getElementById('pg-theme');
  if (!element) {
    element = document.createElement('style');
    element.id = 'pg-theme';
    document.head.appendChild(element);
  }
  const variables = Object.entries(THEMES[name])
    .map(([key, value]) => `--${key}: ${value}`)
    .join('; ');
  element.textContent = `:root { ${variables} }`;
  document.documentElement.dataset.theme = name;
}
