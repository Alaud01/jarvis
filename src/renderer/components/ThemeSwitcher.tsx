import React from 'react';
import { useTheme } from '../context/ThemeContext';

const ThemeSwitcher: React.FC = () => {
  const { theme, setTheme } = useTheme();

  const themes: { id: 'light' | 'dark' | 'system'; name: string; icon: React.ReactNode }[] = [
    {
      id: 'system',
      name: 'System',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
    },
    {
      id: 'light',
      name: 'Light',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ),
    },
    {
      id: 'dark',
      name: 'Dark',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex items-center gap-1 font-mono text-[0.65rem]">
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`group relative flex items-center justify-center w-6 h-6 transition-all duration-[150ms] ${
            theme === t.id 
              ? 'text-text-primary' 
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
          onClick={() => setTheme(t.id)}
          title={`Switch to ${t.name} theme`}
          aria-label={`Switch to ${t.name} theme`}
        >
          {t.icon}
          <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-border-primary bg-bg-secondary px-2 py-1 text-[0.6rem] text-text-primary opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
            {t.name}
          </span>
        </button>
      ))}
    </div>
  );
};

export default ThemeSwitcher;
