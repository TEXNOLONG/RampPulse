import { ChatView } from './ChatView';

export function ChatPanel({ onClose }: { onClose(): void }) {
  return (
    <aside className="detail chat-panel glass">
      <ChatView onClose={onClose} />
    </aside>
  );
}
