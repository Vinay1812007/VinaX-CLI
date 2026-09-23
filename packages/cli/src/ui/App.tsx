import { Box, Text, useApp, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import type { AppStateStore, Env, Runtime, SessionSummary, ThemeName } from '@vinax/core';
import type { OpenedSession, SessionChoice } from '../session.js';
import type { SlashCommand } from './commands/types.js';
import { ChatScreen } from './components/ChatScreen.js';
import { Onboarding, type OnboardingDeps } from './components/Onboarding.js';
import { PickerOverlay } from './components/Overlays.js';
import { TrustPrompt } from './components/TrustPrompt.js';
import { colorDisabled, resolveTheme, ThemeContext } from './theme.js';
import { restoreItems, type TranscriptItem } from './transcript.js';

export interface AppDeps {
  state: AppStateStore;
  /** Reads the configured theme; throws on invalid settings. */
  loadTheme: () => Promise<ThemeName>;
  /** Loads settings, keys and providers. */
  createRuntime: () => Promise<Runtime>;
  openSession: (
    runtime: Runtime,
    choice: SessionChoice,
    cleared?: boolean,
  ) => Promise<OpenedSession>;
  listSessions: (runtime: Runtime) => SessionSummary[];
  loadCommands: (runtime: Runtime) => Promise<{ commands: SlashCommand[]; warnings: string[] }>;
  onboarding: OnboardingDeps;
}

/** `pick` shows the resume picker first (`vinax -r` without an id). */
export type StartChoice = SessionChoice | { kind: 'pick' };

export interface AppProps {
  deps: AppDeps;
  version: string;
  cwd: string;
  env: Env;
  /** Chosen once per process so every render of the welcome panel agrees. */
  tips: readonly string[];
  start: StartChoice;
  initialPrompt?: string | undefined;
  onExit: (code: number) => void;
}

interface ChatState {
  runtime: Runtime;
  opened: OpenedSession;
  commands: SlashCommand[];
  notices: string[];
  restored: TranscriptItem[];
  /** Changing it remounts the chat (new transcript) after /clear or /resume. */
  key: number;
}

type Phase =
  | { name: 'loading' }
  | { name: 'onboarding'; theme: ThemeName }
  | { name: 'trust' }
  | { name: 'starting' }
  | { name: 'pick'; runtime: Runtime; sessions: SessionSummary[] }
  | { name: 'chat'; chat: ChatState }
  | { name: 'error'; message: string };

export function App({ deps, version, cwd, env, tips, start, initialPrompt, onExit }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
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

  const enterChat = async (runtime: Runtime, choice: SessionChoice, key: number): Promise<void> => {
    const opened = await deps.openSession(runtime, choice, key > 0 && choice.kind === 'new');
    const { commands, warnings } = await deps.loadCommands(runtime);
    setPhase({
      name: 'chat',
      chat: {
        runtime,
        opened,
        commands,
        notices: [...opened.notes, ...warnings],
        restored: opened.loaded ? restoreItems(opened.loaded.views) : [],
        key,
      },
    });
  };

  const startChat = async (): Promise<void> => {
    setPhase({ name: 'starting' });
    const runtime = await deps.createRuntime();
    if (start.kind === 'pick') {
      const sessions = deps.listSessions(runtime);
      if (sessions.length > 0) {
        setPhase({ name: 'pick', runtime, sessions });
        return;
      }
      await enterChat(runtime, { kind: 'new' }, 0);
      return;
    }
    await enterChat(runtime, start, 0);
  };

  /** /clear and /resume: wipe the screen and remount the chat on another session. */
  const switchSession = (chat: ChatState, choice: SessionChoice): void => {
    void (async () => {
      await chat.opened.setup.close();
      await suspendTerminal(() => {
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
      });
      await enterChat(chat.runtime, choice, chat.key + 1);
    })().catch(fail);
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
    case 'pick': {
      const { runtime } = phase;
      body = (
        <PickerOverlay
          title="Resume which conversation? (Esc starts a new one)"
          items={phase.sessions.map((s) => ({
            label: s.title ?? (s.firstPrompt ?? '(untitled)').slice(0, 60),
            value: s.id,
            hint: `${s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} · ${String(s.turns)} prompt${s.turns === 1 ? '' : 's'}`,
          }))}
          onDone={(id) => {
            void enterChat(
              runtime,
              id === undefined ? { kind: 'new' } : { kind: 'resume', id },
              0,
            ).catch(fail);
          }}
        />
      );
      break;
    }
    case 'chat': {
      const { chat } = phase;
      body = (
        <ChatScreen
          key={chat.key}
          runtime={chat.runtime}
          setup={chat.opened.setup}
          session={chat.opened.writer}
          commands={chat.commands}
          version={version}
          tips={tips}
          restored={chat.restored}
          title={chat.opened.loaded?.title}
          startupNotices={chat.notices}
          initialPrompt={chat.key === 0 ? initialPrompt : undefined}
          editorMode={chat.runtime.settings.resolved.editorMode}
          onExit={quit}
          onClear={() => {
            switchSession(chat, { kind: 'new' });
          }}
          onResume={(id) => {
            switchSession(chat, { kind: 'resume', id });
          }}
          onTheme={setThemeName}
        />
      );
      break;
    }
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
