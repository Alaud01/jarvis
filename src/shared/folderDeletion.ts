export function folderDeletionMessage(
  folderName: string,
  conversations: ReadonlyArray<{ title: string; isPinned: boolean }>,
): string {
  const count = conversations.length;
  if (count === 0) return `Delete empty folder "${folderName}"?`;

  const message = `Delete folder "${folderName}"? This will delete ${count} conversation${count !== 1 ? 's' : ''} inside it. You can restore these conversations from Recently Deleted for 30 days. The folder itself will not be restored.`;
  const pinned = conversations.filter(conversation => conversation.isPinned);
  return pinned.length === 0 ? message : `${message}\n\nThis includes pinned chats:\n${pinned.map(conversation => `• ${conversation.title}`).join('\n')}`;
}
