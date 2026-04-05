import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'custom';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  customColors: Record<string, string>;
  setCustomColors: (colors: Record<string, string>) => void;
  isDark: boolean;
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

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'custom') {
        return saved;
      }
      return 'dark';
    }
    return 'dark';
  });

  const [customColors, setCustomColorsState] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(CUSTOM_COLORS_KEY);
      return saved ? { ...defaultCustomColors, ...JSON.parse(saved) } : defaultCustomColors;
    }
    return defaultCustomColors;
  });

  const isDark = theme === 'dark' || theme === 'custom';

  useEffect(() => {
    const root = document.documentElement;
    
    // Set theme attribute
    root.setAttribute('data-theme', theme);
    
    // Apply custom colors if in custom mode
    if (theme === 'custom') {
      Object.entries(customColors).forEach(([key, value]) => {
        root.style.setProperty(key, value);
      });
    } else {
      // Reset custom properties when not in custom mode
      Object.keys(customColors).forEach((key) => {
        root.style.removeProperty(key);
      });
    }
    
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, customColors]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  const setCustomColors = (colors: Record<string, string>) => {
    setCustomColorsState((prev) => ({ ...prev, ...colors }));
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify({ ...customColors, ...colors }));
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, customColors, setCustomColors, isDark }}>
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
