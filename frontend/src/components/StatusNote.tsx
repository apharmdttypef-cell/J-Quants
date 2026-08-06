interface StatusNoteProps {
  kind: 'loading' | 'error' | 'empty';
  message: string;
}

export function StatusNote({ kind, message }: StatusNoteProps) {
  if (kind === 'empty') {
    return <div className="empty-state">{message}</div>;
  }
  return <p className={`status-note${kind === 'error' ? ' status-note--error' : ''}`}>{message}</p>;
}
