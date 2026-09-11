export function folderDeletionMessage(
  folderName: string,
  conversations: ReadonlyArray<{ title: string; isPinned: boolean }>,
): string {
  const count = conversations.length;
  if (count === 0) return `Delete empty folder "${folderName}"?`;

  const message = `Delete folder "${folderName}"? This will permanently delete ${count} conversation${count !== 1 ? 's' : ''} inside it.`;
  const pinned = conversations.filter(conversation => conversation.isPinned);
  return pinned.length === 0 ? message : `${message}\n\nThis includes pinned chats:\n${pinned.map(conversation => `• ${conversation.title}`).join('\n')}`;
}
