export interface FileAttachment {
  name: string;
  extension: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface AttachmentSelectionResult {
  attachments: FileAttachment[];
  errors: string[];
}
