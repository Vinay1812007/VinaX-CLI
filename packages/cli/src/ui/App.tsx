import { Box, Text, useApp } from 'ink';
import { useEffect, useState } from 'react';
import type { AppStateStore, Env, Runtime, ThemeName } from '@vinax/core';
import { ChatScreen } from './components/ChatScreen.js';
import { Onboarding, type OnboardingDeps } from './components/Onboarding.js';
import { TrustPrompt } from './components/TrustPrompt.js';
import { colorDisabled, resolveTheme, ThemeContext } from './theme.js';

export interface AppDeps {
  state: AppStateStore;
  /** Reads the configured theme; throws on invalid settings. */
  loadTheme: () => Promise<ThemeName>;
  createRuntime: () => Promise<Runtime>;
  onboarding: OnboardingDeps;
}

export interface AppProps {
  deps: AppDeps;
  version: string;
  cwd: string;
  env: Env;
  /** Chosen once per process so every render of the welcome panel agrees. */
  tips: readonly string[];
  initialPrompt?: string | undefined;
  modelOverride?: string | undefined;
  onExit: (code: number) => void;
}

type Phase =
  | { name: 'loading' }
  | { name: 'onboarding'; theme: ThemeName }
  | { name: 'trust' }
  | { name: 'starting' }
  | { name: 'chat'; runtime: Runtime }
  | { name: 'error'; message: string };

export function App({
  deps,
  version,
  cwd,
  env,
  tips,
  initialPrompt,
  modelOverride,
  onExit,
}: AppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [themeName, setThemeName] = useState<ThemeName>('dark');
  const theme = resolveTheme(themeName, env);

  const quit = (code: number): void => {
    onExit(code);
    exit();
  };

  const fail = (err: unknown): void => {
    setPhase({ name: 'error', message: err instanceof Error ? err.message : String(err) });
  };

  const startChat = async (): Promise<void> => {
    setPhase({ name: 'starting' });
    setPhase({ name: 'chat', runtime: await deps.createRuntime() });
  };

  const afterOnboarding = async (): Promise<void> => {
    if (await deps.state.isTrusted(cwd)) await startChat();
    else setPhase({ name: 'trust' });
  };

  useEffect(() => {
    void (async () => {
      const configured = await deps.loadTheme();
      setThemeName(configured);
      const state = await deps.state.read();
      if (state.onboardingComplete) await afterOnboarding();
      else setPhase({ name: 'onboarding', theme: configured });
    })().catch(fail);
  }, []); // mount only

  useEffect(() => {
    if (phase.name === 'error') quit(1);
  }, [phase.name]);

  let body;
  switch (phase.name) {
    case 'loading':
    case 'starting':
      body = <Text color={theme.muted}>Starting VinaX…</Text>;
      break;
    case 'onboarding':
      body = (
        <Onboarding
          deps={deps.onboarding}
          initialTheme={phase.theme}
          colorDisabled={colorDisabled(env)}
          onThemePreview={setThemeName}
          onDone={() => {
            void deps.state
              .update((s) => ({ ...s, onboardingComplete: true }))
              .then(afterOnboarding)
              .catch(fail);
          }}
        />
      );
      break;
    case 'trust':
      body = (
        <TrustPrompt
          cwd={cwd}
          onAnswer={(trusted) => {
            if (!trusted) {
              quit(1);
              return;
            }
            void deps.state.trust(cwd).then(startChat).catch(fail);
          }}
        />
      );
      break;
    case 'chat':
      body = (
        <ChatScreen
          runtime={phase.runtime}
          version={version}
          tips={tips}
          initialPrompt={initialPrompt}
          modelOverride={modelOverride}
          onExit={quit}
        />
      );
      break;
    case 'error':
      body = <Text color={theme.error}>✖ {phase.message}</Text>;
      break;
  }

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column">{body}</Box>
    </ThemeContext.Provider>
  );
}
