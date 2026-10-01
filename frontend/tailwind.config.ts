import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        'retro': ['Pixeboy', 'monospace', 'sans-serif'],
        // UI redesign (docs/build_plans/ui-redesign): brand, body, labels, numbers.
        'mw-brand': ['Bungee', 'sans-serif'],
        'mw-body': ['Barlow', 'system-ui', 'sans-serif'],
        'mw-cond': ['"Barlow Condensed"', 'sans-serif'],
        'mw-mono': ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        mw: {
          ground: "var(--mw-ground)",
          surface: "var(--mw-surface)",
          raised: "var(--mw-raised)",
          border: "var(--mw-border)",
          edge: "var(--mw-edge)",
          input: "var(--mw-input)",
          text: "var(--mw-text)",
          muted: "var(--mw-muted)",
          accent: "var(--mw-accent)",
          "accent-soft": "var(--mw-accent-soft)",
          "accent-fill": "var(--mw-accent-fill)",
          "accent-edge": "var(--mw-accent-edge)",
          buy: "var(--mw-buy)",
          sell: "var(--mw-sell)",
          up: "var(--mw-up)",
          down: "var(--mw-down)",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      boxShadow: {
        'glow-primary': '0 0 20px hsl(var(--glow-primary) / 0.5)',
        'glow-accent': '0 0 30px hsl(var(--glow-accent) / 0.6)',
        'glow-success': '0 0 20px hsl(var(--glow-success) / 0.4)',
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        "pulse-bounce": {
          "0%, 100%": {
            transform: "scale(1)",
            opacity: "0.8",
          },
          "50%": {
            transform: "scale(1.15)",
            opacity: "1",
          },
        },
        "flash": {
          "0%, 100%": {
            opacity: "0.1",
          },
          "50%": {
            opacity: "0.3",
          },
        },
        "glow-pulse": {
          "0%, 100%": {
            opacity: "0.3",
            transform: "scale(1)",
          },
          "50%": {
            opacity: "0.6",
            transform: "scale(1.1)",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-bounce": "pulse-bounce 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) infinite",
        "flash": "flash 0.8s ease-in-out infinite",
        "glow-pulse": "glow-pulse 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
