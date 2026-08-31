export type SettingsIconName =
  | 'back'
  | 'general'
  | 'ai'
  | 'skills'
  | 'browser'
  | 'channels'
  | 'agent'
  | 'data'
  | 'diagnostics'
  | 'about'
  | 'moon'
  | 'sun'
  | 'plus'
  | 'daily-automation';

const paths: Record<SettingsIconName, React.JSX.Element> = {
  back: <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>,
  general: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  ai: <><path d="M12 3 14 8l5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></>,
  skills: <><path d="M8.5 4H4v4.5a2.5 2.5 0 1 1 0 5V18h4.5a2.5 2.5 0 1 0 5 0H18v-4.5a2.5 2.5 0 1 0 0-5V4h-4.5a2.5 2.5 0 1 1-5 0Z"/></>,
  browser: <><circle cx="12" cy="12" r="9"/><path d="M3 9h18M8 21c-2-5-2-13 0-18M16 21c2-5 2-13 0-18"/></>,
  channels: <><path d="M5 5a14 14 0 0 1 14 14M5 10a9 9 0 0 1 9 9"/><circle cx="6" cy="18" r="1.5"/></>,
  agent: <><circle cx="12" cy="8" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2M5 9H3M21 9h-2M12 3V1"/></>,
  data: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  diagnostics: <><path d="M4 12h3l2-5 4 10 2-5h5"/><circle cx="12" cy="12" r="9"/></>,
  about: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  moon: <><path d="M20 15.2A8 8 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  'daily-automation': <><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/><path d="M16 5l1 2M8 5L7 7M16 19l1-2M8 19l-1-2"/><path d="M12 16a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></>,
};


export function SettingsIcon({ name, className }: { name: SettingsIconName; className?: string }): React.JSX.Element {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
