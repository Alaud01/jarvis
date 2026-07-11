import { createContext } from 'react';

export type Theme = 'light' | 'dark' | 'system' | 'custom';

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  customColors: Record<string, string>;
  setCustomColors: (colors: Record<string, string>) => void;
  isDark: boolean;
  resolvedTheme: 'light' | 'dark';
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
