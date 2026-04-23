import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system' | 'custom';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  customColors: Record<string, string>;
  setCustomColors: (colors: Record<string, string>) => void;
  isDark: boolean;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'openchat-theme';
const CUSTOM_COLORS_KEY = 'openchat-custom-colors';

const defaultCustomColors: Record<string, string> = {
  '--color-accent-primary': '#8b5cf6',
  '--color-accent-secondary': '#ec4899',
  '--color-accent-primary-hover': '#7c3aed',
  '--color-accent-secondary-hover': '#db2777',
};

const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
};

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'system' || saved === 'custom') {
        return saved;
      }
      return 'system';
    }
    return 'system';
  });
  
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    if (theme === 'system') {
      return getSystemTheme();
    }
    return theme === 'light' ? 'light' : 'dark';
  });

  const [customColors, setCustomColorsState] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(CUSTOM_COLORS_KEY);
      return saved ? { ...defaultCustomColors, ...JSON.parse(saved) } : defaultCustomColors;
    }
    return defaultCustomColors;
  });

  const isDark = resolvedTheme === 'dark';

  useEffect(() => {
    const root = document.documentElement;
    
    const effectiveTheme = theme === 'system' ? getSystemTheme() : (theme === 'light' ? 'light' : 'dark');
    setResolvedTheme(effectiveTheme);
    
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-resolved-theme', effectiveTheme);

    if (window.assistant?.setThemeBackground) {
      window.assistant.setThemeBackground(effectiveTheme === 'dark');
    }
    
    if (theme === 'custom') {
      Object.entries(customColors).forEach(([key, value]) => {
        root.style.setProperty(key, value);
      });
    } else {
      Object.keys(customColors).forEach((key) => {
        root.style.removeProperty(key);
      });
    }
    
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, customColors]);
  
  useEffect(() => {
    if (theme !== 'system') return;
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const newResolved = getSystemTheme();
      setResolvedTheme(newResolved);
      document.documentElement.setAttribute('data-resolved-theme', newResolved);
      if (window.assistant?.setThemeBackground) {
        window.assistant.setThemeBackground(newResolved === 'dark');
      }
    };
    
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  const setCustomColors = (colors: Record<string, string>) => {
    setCustomColorsState((prev) => ({ ...prev, ...colors }));
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify({ ...customColors, ...colors }));
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, customColors, setCustomColors, isDark, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
