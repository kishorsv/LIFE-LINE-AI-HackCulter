import React, { useState } from 'react';
import {
  Bell,
  FlaskConical,
  Menu,
  Moon,
  Shield,
  Siren,
  Sun,
  UserCircle2,
  X,
} from 'lucide-react';
import { ActiveView } from '../types/lifeline.ts';
import { useTheme } from '../contexts/ThemeContext.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { PWAInstallButton } from './PWAInstallButton.tsx';

interface NavbarProps {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
  onOpenAuth: () => void;
  onOpenSos: () => void;
  onToggleNotifications: () => void;
}

export function Navbar({ activeView, onNavigate, onOpenAuth, onOpenSos, onToggleNotifications }: NavbarProps) {
  const { theme, toggleTheme } = useTheme();
  const { user, demoMode, setDemoMode, notifications } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const navItems: Array<{ id: ActiveView; label: string }> = [
    { id: 'landing', label: 'Overview' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'map', label: 'Live Map' },
    { id: 'agents', label: 'AI Agents' },
    { id: 'operator', label: 'Operator Desk' },
  ];

  const handleNav = (id: ActiveView) => {
    setMobileOpen(false);
    if (id !== 'landing' && id !== 'map' && !user) {
      onOpenAuth();
      return;
    }
    onNavigate(id);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 dark:border-violet-500/20 bg-white/85 dark:bg-[#070B18]/85 backdrop-blur-xl">
      {/* Primary 3-Zone Top Bar */}
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Left: Brand Logo */}
        <button
          type="button"
          onClick={() => onNavigate('landing')}
          className="flex shrink-0 items-center gap-2.5 text-left focus:outline-none"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-700 text-white shadow-lg shadow-violet-600/30">
            <Shield className="h-5 w-5" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white">
              LIFE-LINE <span className="text-violet-600 dark:text-violet-400">AI</span>
            </span>
            <span className="text-[10px] font-medium tracking-wider text-slate-500 dark:text-slate-400">
              SAFETY INTELLIGENCE
            </span>
          </span>
        </button>

        {/* Center: 5 single-line navigation links */}
        <nav className="hidden lg:flex items-center gap-1 whitespace-nowrap">
          {navItems.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNav(item.id)}
                className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-violet-600/12 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70 dark:hover:text-white'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Right: Single Primary CTA + Mobile Trigger */}
        <div className="flex shrink-0 items-center gap-2.5">
          {user ? (
            <button
              type="button"
              onClick={onOpenSos}
              className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-600/30 hover:bg-rose-500 transition-colors whitespace-nowrap"
            >
              <Siren className="h-4 w-4" />
              <span>Emergency SOS</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenAuth}
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-600/25 hover:bg-violet-500 transition-colors whitespace-nowrap"
            >
              <span>Get Started</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="lg:hidden rounded-lg p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Toggle navigation menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Compact Secondary Utility Strip */}
      <div className="border-t border-slate-200/70 dark:border-slate-800/80 bg-slate-50/90 dark:bg-[#0A1022]/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-1.5 sm:px-6 text-xs">
          <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
            <button
              type="button"
              onClick={() => setDemoMode(!demoMode)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium transition-colors ${
                demoMode
                  ? 'border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-500/40'
              }`}
            >
              <FlaskConical className="h-3.5 w-3.5" />
              <span>{demoMode ? 'Hackathon Demo Mode: ON' : 'Demo Mode: OFF'}</span>
            </button>
            <span className="hidden sm:inline text-slate-500 dark:text-slate-400">
              Immediate physical danger? Call local emergency services (911 / 112 / 999).
            </span>
          </div>

          <div className="flex items-center gap-2">
            <PWAInstallButton />
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800"
              aria-label="Toggle color theme"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5 text-amber-400" /> : <Moon className="h-3.5 w-3.5 text-violet-600" />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>

            {user ? (
              <>
                <button
                  type="button"
                  onClick={onToggleNotifications}
                  className="relative inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800"
                >
                  <Bell className="h-3.5 w-3.5" />
                  <span>Alerts</span>
                  {unreadCount > 0 && (
                    <span className="tabular-nums rounded bg-rose-600 px-1.5 text-[10px] font-bold text-white">
                      {unreadCount}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('profile')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  <span className="max-w-[130px] truncate">{user.displayName}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onOpenAuth}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800"
              >
                Sign In / Judge Sandbox
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="lg:hidden border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#090E1E] px-4 py-3 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleNav(item.id)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium ${
                activeView === item.id
                  ? 'bg-violet-600/15 text-violet-700 dark:text-violet-300'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
