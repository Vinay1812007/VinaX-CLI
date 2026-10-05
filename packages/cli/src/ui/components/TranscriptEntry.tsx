import type { ReactNode } from 'react';
import type { TranscriptItem } from '../transcript.js';
import {
  AssistantMarkdown,
  ErrorCard,
  Notice,
  Panel,
  ShellEntry,
  ThoughtLine,
  TurnSummary,
  UserMessage,
} from './Messages.js';
import { ToolEntry } from './ToolEntry.js';

/** One permanent transcript item (printed once into the terminal's scrollback). */
export function TranscriptEntry({
  item,
  width,
  welcome,
}: {
  item: TranscriptItem;
  width: number;
  /** The welcome banner, built by the screen that knows the session. */
  welcome: () => ReactNode;
}) {
  switch (item.kind) {
    case 'welcome':
      return welcome();
    case 'user':
      return <UserMessage text={item.text} />;
    case 'assistant':
      return <AssistantMarkdown markdown={item.markdown} first={item.first} width={width} />;
    case 'notice':
      return <Notice level={item.level} text={item.text} />;
    case 'panel':
      return <Panel title={item.title} markdown={item.markdown} width={width} />;
    case 'shell':
      return <ShellEntry command={item.command} output={item.output} exitCode={item.exitCode} />;
    case 'tool':
      return (
        <ToolEntry
          name={item.name}
          label={item.label}
          ok={item.ok}
          summary={item.summary}
          display={item.display}
          durationMs={item.durationMs}
          width={width}
        />
      );
    case 'error':
      return <ErrorCard report={item.report} width={width} />;
    case 'summary':
      return <TurnSummary text={item.text} />;
    case 'thought':
      return <ThoughtLine durationMs={item.durationMs} />;
  }
}
